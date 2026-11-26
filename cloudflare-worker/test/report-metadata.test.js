import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../mdev-src/report-metadata.js', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../../mdev-src/editor.js', import.meta.url), 'utf8');
function context(extra = {}) {
  const ctx = vm.createContext({ setTimeout, clearTimeout, ...extra });
  vm.runInContext(source, ctx);
  return ctx;
}
const api = vm.runInContext('MdevReportMetadata', context());
const stamp = '2026-11-17T22:36:10.123Z';

test('full client hints prefer real product and version over Chromium and GREASE', async () => {
  const result = await api.collect({ userAgentData: {
    brands: [{ brand: 'Chromium', version: '142' }],
    getHighEntropyValues: async () => ({ platform: 'Windows', fullVersionList: [
      { brand: 'Not A Brand', version: '99' }, { brand: 'Chromium', version: '142.0.0.0' },
      { brand: 'Microsoft Edge', version: '142.0.123.4' }
    ] })
  } }, new Date(stamp));
  assert.equal(result.browser, 'Microsoft Edge 142.0.123.4');
  assert.equal(result.os, 'Windows');
  assert.equal(result.submittedAt, stamp);
});

test('UA fallback distinguishes browsers and OS without inventing OS versions', () => {
  for (const [ua, browser, os] of [
    ['Mozilla Windows NT 10.0 Chrome/142.0.1.2 Edg/142.0.3.4', 'Microsoft Edge 142.0.3.4', 'Windows'],
    ['Mozilla X11 Linux x86_64 Chrome/142.0.1.2 OPR/123.4', 'Opera 123.4', 'Linux'],
    ['Mozilla Macintosh Mac OS X 10_15_7 Version/18.2 Safari/605.1', 'Safari 18.2', 'macOS'],
    ['Mozilla Android 12 Chrome/142.0.1.2', 'Google Chrome 142.0.1.2', 'Android'],
    ['Mozilla CrOS x86_64 Chrome/142.0.1.2', 'Google Chrome 142.0.1.2', 'Chrome OS'],
    ['Mozilla iPhone FxiOS/100.1', 'Firefox 100.1', 'iOS']
  ]) {
    const result = api.detect({ userAgent: ua });
    assert.equal(result.browser, browser); assert.equal(result.os, os);
  }
});

test('denied, absent and stalled hints degrade safely; low entropy brands remain usable', async () => {
  for (const getHighEntropyValues of [async () => { throw Error('denied'); }, () => new Promise(() => {})]) {
    const result = await api.collect({ userAgentData: { getHighEntropyValues,
      brands: [{ brand: 'Chromium', version: '142' }], platform: 'Linux' } }, new Date(stamp));
    assert.equal(result.browser, 'Chromium 142'); assert.equal(result.os, 'Linux');
  }
  const result = await api.collect({}, new Date(stamp));
  assert.equal(result.browser, 'Unknown'); assert.equal(result.os, 'Unknown');
});

test('Kyiv time displays seconds without timezone suffix or ISO timestamp; legacy metadata renders safely', () => {
  const lines = api.lines({ submittedAt: stamp, browser: 'Chromium 142', os: 'Linux' });
  assert.equal(lines[2], 'Submitted: 18 Nov 2026, 00:36:10');
  assert.equal(api.lines({ submittedAt: '2026-07-17T22:36:10.123Z' })[2], 'Submitted: 18 Jul 2026, 01:36:10');
  for (const metadata of [undefined, {}, { submittedAt: 'invalid' }]) {
    assert.equal(api.lines(metadata).join('\n'), 'Browser: Unknown\nOS: Unknown\nSubmitted: Unknown');
  }
});

for (const destination of ['notion', 'gdocs']) {
  test(`${destination} outgoing API payload preserves and displays all metadata, including legacy fallback`, async () => {
    for (const metadata of [{ browser: 'Microsoft Edge 142.1', os: 'Windows', submittedAt: stamp }, undefined]) {
      const calls = [];
      const ctx = context({
        document: { getElementById: () => ({ value: 'database-id' }) },
        fetch: async (url, options) => {
          calls.push({ url, options });
          return { ok: true, json: async () => ({ body: { content: [] } }) };
        },
        getGoogleAuthToken: async () => 'test-token', getGdocId: async () => 'doc-id',
        notionHeaders: () => ({}), uploadFileToNotion: async () => null,
        pageUrl: 'https://example.test', extraFiles: []
      });
      const helpers = editor.slice(editor.indexOf('function textBlock('), editor.indexOf('/* ─────────────────── Google Docs section builder'));
      const submit = editor.slice(editor.indexOf('async function submitToNotion('), editor.indexOf("document.getElementById('submit-btn').addEventListener"));
      const append = editor.slice(editor.indexOf('async function appendReportToGoogleDoc('), editor.indexOf('/* ─────────────────── Submit'));
      vm.runInContext(helpers + append + submit, ctx);
      ctx.fields = { title: 'Report', desc: 'Description', status: 'TODO', severity: 'Low', metadata };
      await vm.runInContext(destination === 'notion' ? 'submitToNotion(fields)' : 'submitToGoogleDocs(fields)', ctx);
      const call = calls.find(c => c.options?.method === 'POST');
      const payload = JSON.parse(call.options.body);
      const text = destination === 'notion'
        ? payload.children.filter(b => b.type === 'paragraph').map(b => b.paragraph.rich_text[0].text.content).join('\n')
        : payload.requests[0].insertText.text;
      for (const line of api.lines(metadata)) assert.ok(text.includes(line), line);
      assert.ok(text.includes('Description'));
      if (destination === 'notion') {
        const detailsIndex = payload.children.findIndex(b => b.heading_2?.rich_text[0].text.content === 'Report Details');
        assert.ok(detailsIndex > 0);
        assert.equal(payload.children[detailsIndex - 1].type, 'divider');
        assert.equal(payload.children[detailsIndex + 1].paragraph.rich_text[0].text.content, api.lines(metadata)[0]);
      } else {
        assert.ok(text.indexOf('Report Details') > text.indexOf('Description'));
        const heading = payload.requests.find(r => r.updateParagraphStyle &&
          text.slice(r.updateParagraphStyle.range.startIndex - 1, r.updateParagraphStyle.range.endIndex - 1) === 'Report Details');
        assert.equal(heading.updateParagraphStyle.paragraphStyle.namedStyleType, 'HEADING_3');
      }
    }
  });
}

test('editor loads metadata helper before submission code and collects once per attempt', () => {
  const html = readFileSync(new URL('../../mdev-src/editor.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="report-metadata.js"') < html.indexOf('src="editor.js"'));
  const submit = editor.slice(editor.indexOf("document.getElementById('submit-btn').addEventListener"));
  assert.match(submit, /const metadata = await MdevReportMetadata.collect\(\)/);
  assert.match(submit, /const fields = \{ metadata,/);
});
