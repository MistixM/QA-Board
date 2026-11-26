import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/index.js';

const ORIGIN = 'chrome-extension://iaohooohkpmcjnnfnabbggfobfcjackm';
const DESCRIPTION = 'The checkout button does nothing when clicked.';

function request(body = { task: 'title', description: DESCRIPTION }, options = {}) {
  return new Request('https://mdev-qa-ai.example.workers.dev/generate', {
    method: 'POST',
    headers: { Origin: ORIGIN, Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...options
  });
}

function environment(run = async () => ({ response: 'Checkout button fails' })) {
  return { ALLOWED_ORIGIN: ORIGIN, AI_ENDPOINT_TOKEN: 'test-token', AI: { run } };
}

test('configured extension origin matches the manifest signing key', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../mdev-src/manifest.json', import.meta.url)));
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url)));
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal(config.vars.ALLOWED_ORIGIN, `chrome-extension://${id}`);
  assert.equal(config.vars.ALLOWED_ORIGIN, ORIGIN);
});

test('all three tasks invoke the chosen model with server-defined prompts', async () => {
  for (const task of ['title', 'brief', 'severity']) {
    const response = await worker.fetch(request({ task, description: DESCRIPTION }), environment(async (model, input) => {
      assert.equal(model, '@cf/openai/gpt-oss-20b');
      assert.equal(input.stream, false);
      assert.equal(input.messages[0].role, 'system');
      assert.ok(input.messages[1].content.endsWith(DESCRIPTION));
      assert.equal(input.messages.length, 2);
      return { response: ' High ' };
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'High' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('chat-completion output is supported', async () => {
  const response = await worker.fetch(request(), environment(async () => ({ choices: [{ message: { content: 'A title' } }] })));
  assert.deepEqual(await response.json(), { text: 'A title' });
});

test('invalid credentials and disallowed origins cannot invoke inference', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  for (const authorization of ['', 'Bearer wrong-token']) {
    const input = request();
    input.headers.set('Authorization', authorization);
    assert.equal((await worker.fetch(input, env)).status, 401);
  }
  const input = request();
  input.headers.set('Origin', 'https://example.com');
  const response = await worker.fetch(input, env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls, 0);
});

test('preflight, routing, methods, configuration, and authenticated CLI requests', async () => {
  const preflight = new Request('https://worker.workers.dev/generate', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  const response = await worker.fetch(preflight, environment());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assert.equal((await worker.fetch(new Request('https://worker.workers.dev/other'), environment())).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.workers.dev/generate'), environment())).status, 405);
  assert.equal((await worker.fetch(request(), { ...environment(), AI_ENDPOINT_TOKEN: '' })).status, 503);
  const cli = request();
  cli.headers.delete('Origin');
  assert.equal((await worker.fetch(cli, environment())).status, 200);
});

test('malformed input is rejected before inference', async () => {
  let calls = 0;
  const env = environment(async () => { calls++; });
  for (const body of [null, {}, { task: {} }, { task: 'constructor', description: DESCRIPTION },
    { task: 'unknown', description: DESCRIPTION }, { task: 'title', description: 'short' },
    { task: 'title', description: 42 }]) {
    assert.equal((await worker.fetch(request(body), env)).status, 400);
  }
  assert.equal((await worker.fetch(request(null, { body: '{' }), env)).status, 400);
  const wrongContentType = request();
  wrongContentType.headers.set('Content-Type', 'text/plain');
  assert.equal((await worker.fetch(wrongContentType, env)).status, 415);
  assert.equal(calls, 0);
});

test('empty and malformed upstream output produce a recoverable error', async () => {
  for (const result of [null, {}, { response: '' }, { response: {} }, { response: '   ' }]) {
    const response = await worker.fetch(request(), environment(async () => result));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /empty or malformed/);
  }
});

test('quota, capacity, timeout, paid-plan, and generic failures have clear sanitized errors', async () => {
  const cases = [
    ['3036: daily free allocation exhausted', 429, /daily free allocation/],
    ['3040: capacity temporarily exceeded', 429, /busy or rate-limited/],
    ['3007: timeout', 504, /timed out/],
    ['5035: model requires Workers Paid plan', 502, /paid plan/],
    ['private-account-detail', 502, /generation failed/]
  ];
  for (const [message, status, expected] of cases) {
    const response = await worker.fetch(request(), environment(async () => { throw new Error(message); }));
    assert.equal(response.status, status);
    const body = await response.json();
    assert.match(body.error, expected);
    assert.ok(!body.error.includes('private-account-detail'));
  }
  const response = await worker.fetch(request(), environment(async () => {
    throw Object.assign(new Error('Account limited'), { internalCode: 3036 });
  }));
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /daily free allocation/);
});

test('inference timeout is bounded and its timer is cleared', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = worker.fetch(request(), environment(() => {
    started();
    return new Promise(() => {});
  }));
  await ready;
  context.mock.timers.tick(55000);
  assert.equal((await pending).status, 504);
});
