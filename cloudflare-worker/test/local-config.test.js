import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../mdev-src/editor.js', import.meta.url), 'utf8');
const constants = source.slice(0, source.indexOf('/* Target Google Doc'));
const helpers = source.slice(source.indexOf('async function loadDatabases()'), source.indexOf('/* ─────────────────── Destination switcher'));
function context(config) {
  const select = {};
  const ctx = vm.createContext({ MDEV_CONFIG: config, document: { getElementById: () => select } });
  vm.runInContext(constants + helpers, ctx);
  return { ctx, select };
}

test('missing local Notion config explains setup without making network requests', async () => {
  const { ctx, select } = context(undefined);
  await vm.runInContext('loadDatabases()', ctx);
  assert.match(select.innerHTML, /Notion setup required/);
  assert.match(select.title, /config.local.js/);
  assert.throws(() => vm.runInContext('notionHeaders()', ctx), /Configure notionApiKey/);
});

test('Notion headers use configured credentials and database fallback is optional', () => {
  const { ctx } = context({ notionApiKey: ' test-token ' });
  assert.equal(vm.runInContext('notionHeaders().Authorization', ctx), 'Bearer test-token');
  assert.equal(vm.runInContext('NOTION_DB_ID', ctx), '');
});

test('local config loads before editor and committed example contains no credentials', () => {
  const html = readFileSync(new URL('../../mdev-src/editor.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('src="config.local.js"') < html.indexOf('src="editor.js"'));
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../../mdev-src/config.example.js', import.meta.url), 'utf8'), ctx);
  assert.equal(ctx.MDEV_CONFIG.notionApiKey, '');
  assert.equal(ctx.MDEV_CONFIG.notionDatabaseId, '');
});
