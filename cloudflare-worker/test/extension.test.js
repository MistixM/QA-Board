import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const clientSource = readFileSync(new URL('../../mdev-src/ai-client.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../../mdev-src/editor.js', import.meta.url), 'utf8');
const aiSource = editorSource.slice(editorSource.indexOf('const aiBtn '), editorSource.indexOf('/* ─────────────────── Extra files'));
const settings = { aiWorkerUrl: 'https://mdev-qa-ai.example.workers.dev', aiWorkerToken: 'test-token' };

function client(fetch) {
  const context = vm.createContext({ URL, fetch, Error });
  vm.runInContext(clientSource, context);
  return context.MdevAi;
}

function editor(generate) {
  const elements = new Map();
  for (const id of ['ai-gen-btn', 'f-desc', 'f-title', 'f-brief', 'f-severity']) {
    elements.set(id, {
      value: '', disabled: false, innerHTML: '', listeners: {},
      classList: { add() {}, remove() {} },
      addEventListener(name, handler) { this.listeners[name] = handler; }
    });
  }
  const alerts = [];
  let timeoutHandler;
  let cleared = false;
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) },
    chrome: { storage: { local: { get: async () => settings } } },
    MdevAi: { generate }, AbortController,
    setTimeout: handler => { timeoutHandler = handler; return 1; },
    clearTimeout: () => { cleared = true; },
    alert: message => alerts.push(message)
  });
  vm.runInContext(aiSource, context);
  const description = elements.get('f-desc');
  description.value = 'The checkout button does nothing when clicked.';
  description.listeners.input();
  return {
    elements, alerts,
    click: () => elements.get('ai-gen-btn').listeners.click(),
    timeout: () => timeoutHandler(),
    timerCleared: () => cleared
  };
}

test('Worker URLs are normalized and unsuitable destinations rejected', () => {
  const api = client();
  assert.equal(api.normalizeWorkerUrl(`${settings.aiWorkerUrl}/generate/`), settings.aiWorkerUrl);
  for (const url of ['', 'http://example.workers.dev', 'https://example.com',
    'https://example.workers.dev.evil.com', 'https://user:secret@example.workers.dev',
    'https://example.workers.dev/other', 'https://example.workers.dev?token=secret']) {
    assert.throws(() => api.normalizeWorkerUrl(url));
  }
});

test('client posts only task and description with the saved endpoint token', async () => {
  const signal = new AbortController().signal;
  const api = client(async (url, options) => {
    assert.equal(url, `${settings.aiWorkerUrl}/generate`);
    assert.deepEqual(JSON.parse(options.body), { task: 'title', description: 'Description text' });
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.signal, signal);
    assert.equal(options.redirect, 'error');
    return Response.json({ text: ' Generated title ' });
  });
  assert.equal(await api.generate('title', 'Description text', settings, signal), 'Generated title');
});

test('client reports missing setup, malformed output, authentication, origin, quota, and upstream errors', async () => {
  const signal = new AbortController().signal;
  const api = client();
  await assert.rejects(api.generate('title', 'Description text', {}, signal), /popup/);
  await assert.rejects(api.generate('title', 'Description text', { aiWorkerUrl: settings.aiWorkerUrl }, signal), /endpoint token/);
  const cases = [
    [() => Response.json({}), /malformed/],
    [() => Response.json({ text: ' ' }), /malformed/],
    [() => new Response('invalid JSON'), /invalid response/],
    [() => new Response('Unauthorized', { status: 401 }), /authentication failed/],
    [() => Response.json({}, { status: 403 }), /ALLOWED_ORIGIN/],
    [() => Response.json({ error: 'Daily quota exhausted.' }, { status: 429 }), /Daily quota exhausted/],
    [() => new Response('rate limited', { status: 429 }), /daily allocation/],
    [() => new Response('gateway timeout', { status: 504 }), /timed out/],
    [() => Response.json({}, { status: 502 }), /HTTP 502/]
  ];
  for (const [response, expected] of cases) {
    await assert.rejects(client(async () => response()).generate('title', 'Description text', settings, signal), expected);
  }
  await assert.rejects(client(async () => { throw new TypeError('Failed to fetch'); }).generate('title', 'Description text', settings, signal), /Could not reach/);
});

test('editor fills all fields together and normalizes severity', async () => {
  const tasks = [];
  const ui = editor(async (task, description, savedSettings) => {
    tasks.push(task);
    assert.equal(savedSettings, settings);
    assert.match(description, /checkout/);
    return { title: 'Checkout button fails', brief: 'Checkout cannot proceed.', severity: 'hIgH' }[task];
  });
  await ui.click();
  assert.deepEqual(tasks, ['title', 'brief', 'severity']);
  assert.equal(ui.elements.get('f-title').value, 'Checkout button fails');
  assert.equal(ui.elements.get('f-brief').value, 'Checkout cannot proceed.');
  assert.equal(ui.elements.get('f-severity').value, 'High');
  assert.equal(ui.elements.get('ai-gen-btn').disabled, false);
  assert.equal(ui.alerts.length, 0);
  assert.ok(ui.timerCleared());
});

test('failed generation and invalid severity preserve existing form values', async () => {
  for (const generate of [
    async task => { if (task === 'brief') throw new Error('Daily quota exhausted.'); return 'Generated'; },
    async () => 'Unsupported severity'
  ]) {
    const ui = editor(generate);
    for (const id of ['f-title', 'f-brief', 'f-severity']) ui.elements.get(id).value = `Existing ${id}`;
    await ui.click();
    for (const id of ['f-title', 'f-brief', 'f-severity']) assert.equal(ui.elements.get(id).value, `Existing ${id}`);
    assert.equal(ui.alerts.length, 1);
    assert.equal(ui.elements.get('ai-gen-btn').disabled, false);
    assert.ok(ui.timerCleared());
  }
});

test('description edits and repeated clicks cannot start overlapping generations', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const ui = editor(async task => {
    calls++;
    await pending;
    return task === 'severity' ? 'Low' : 'Generated text';
  });
  const generation = ui.click();
  ui.elements.get('f-desc').listeners.input();
  assert.equal(ui.elements.get('ai-gen-btn').disabled, true);
  await ui.click();
  release();
  await generation;
  assert.equal(calls, 3);
});

test('timeout aborts every request and restores the button', async () => {
  const signals = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const ui = editor((task, description, savedSettings, signal) => new Promise((resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    if (signals.length === 3) started();
  }));
  const generation = ui.click();
  await ready;
  ui.timeout();
  await generation;
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  assert.match(ui.alerts[0], /timed out/);
  assert.equal(ui.elements.get('ai-gen-btn').disabled, false);
});

test('popup saves local settings only after specific-host permission is granted', async () => {
  const popupSource = readFileSync(new URL('../../mdev-src/popup.js', import.meta.url), 'utf8');
  for (const granted of [true, false]) {
    const elements = new Map();
    const getElement = id => {
      if (!elements.has(id)) elements.set(id, { value: '', listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } });
      return elements.get(id);
    };
    let saved;
    let accessLevel;
    const context = vm.createContext({
      document: { getElementById: getElement },
      MdevAi: client(),
      chrome: {
        storage: {
          sync: { get() {} },
          local: {
            get: async () => ({}),
            setAccessLevel: async value => { accessLevel = value.accessLevel; },
            set: async value => { saved = value; }
          }
        },
        permissions: { request: async value => {
          assert.equal(value.origins[0], `${settings.aiWorkerUrl}/*`);
          return granted;
        } }
      }
    });
    vm.runInContext(popupSource, context);
    await Promise.resolve();
    getElement('ai-worker-url').value = settings.aiWorkerUrl;
    getElement('ai-worker-token').value = settings.aiWorkerToken;
    await getElement('ai-settings-form').listeners.submit({ preventDefault() {} });
    if (granted) {
      assert.equal(saved.aiWorkerUrl, settings.aiWorkerUrl);
      assert.equal(saved.aiWorkerToken, settings.aiWorkerToken);
      assert.equal(accessLevel, 'TRUSTED_CONTEXTS');
      assert.match(getElement('ai-settings-status').textContent, /saved/);
    } else {
      assert.equal(saved, undefined);
      assert.match(getElement('ai-settings-status').textContent, /Allow access/);
    }
    assert.equal(getElement('ai-save-btn').disabled, false);
  }
});
