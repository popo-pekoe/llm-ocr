const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../batch-ocr.js');

global.FileReader = class {
  readAsDataURL() { this.result = 'data:image/png;base64,dGVzdA=='; this.onload(); }
};
const ok = rows => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ rows }) }] } }] }) });

test('OCR preserves labels, multiline content, and pipe-separated table rows', async () => {
  const rows = [{ label: '住所', content: '東京都\n1-2-3' }, { label: '', content: '品名 | 数量 | 金額' }, { label: '', content: '部材 |  | 1,000' }];
  let request;
  const result = await core.recognizePage({ type: 'image/png' }, 'test-key', '全文', async (url, options) => { request = JSON.parse(options.body); return ok(rows); });
  assert.deepEqual(result, rows);
  assert.equal(request.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(request.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test('temporary API errors retry only up to three requests; authentication fails immediately', async () => {
  for (const status of [429, 503, 403]) {
    let calls = 0;
    const delays = [];
    await assert.rejects(core.recognizePage({ type: 'image/png' }, 'test', '', async () => { calls++; return { ok: false, status }; }, async ms => delays.push(ms)), error => error.status === status);
    assert.equal(calls, status === 403 ? 1 : 3);
    assert.deepEqual(delays, status === 403 ? [] : status === 429 ? [15000, 30000] : [2000, 4000]);
  }
});

test('a retry can succeed without changing the returned data', async () => {
  let calls = 0;
  const rows = [{ label: '名前', content: 'テスト' }];
  assert.deepEqual(await core.recognizePage({ type: 'image/png' }, 'test', '', async () => ++calls === 1 ? { ok: false, status: 429 } : ok(rows), async () => {}), rows);
  assert.equal(calls, 2);
});

test('truncated and malformed responses cannot be recorded as success', async () => {
  await assert.rejects(core.recognizePage({ type: 'image/png' }, 'test', '', async () => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) })), /MAX_TOKENS/);
  await assert.rejects(core.recognizePage({ type: 'image/png' }, 'test', '', async () => ok([{ label: '名前', content: 123 }])), /形式/);
  assert.deepEqual(await core.recognizePage({ type: 'image/png' }, 'test', '', async () => ok([])), []);
});

test('directory traversal reads all batches including over 100 files and preserves subfolder paths', async () => {
  const fileEntry = path => ({ isFile: true, fullPath: path, file: resolve => resolve({ name: path.split('/').pop() }) });
  const dir = (batches, path) => ({ isDirectory: true, fullPath: path, createReader: () => { let index = 0; return { readEntries: resolve => resolve(batches[index++] || []) }; } });
  const nested = dir([[fileEntry('/root/sub/same.png')]], '/root/sub');
  const root = dir([Array.from({ length: 100 }, (_, i) => fileEntry(`/root/${i}.png`)), [fileEntry('/root/100.png'), nested]], '/root');
  const files = await core.collectEntries([root]);
  assert.equal(files.length, 102);
  assert.equal(files.at(-1).path, 'root/sub/same.png');
  assert.equal((await core.collectEntries([root], false)).length, 101);
});

test('sheet names are unique, valid, case insensitive, and at most 31 characters', () => {
  const used = new Set();
  const names = ['a/同名.pdf', 'b/同名.png', '長'.repeat(50) + '.pdf', '長'.repeat(50) + '.png', 'History.pdf', "'abc'.pdf", 'test.pdf', 'TEST.png'].map(path => core.sheetName(path, used));
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
  assert(names.every(name => name.length <= 31 && !/[\\/?*\[\]:]/.test(name)));
  assert.equal(names[0], '同名');
  assert.equal(names[1], '同名_2');
  assert.notEqual(names[4].toLowerCase(), 'history');
  assert.equal(names[5], 'abc');
});

test('a single PDF sheet retains page order and visibly identifies failed and unprocessed pages', () => {
  const rows = core.sheetRows({ path: 'folder/sample.pdf', pageCount: 3, pages: {
    0: { status: 'done', rows: [{ label: '電話', content: '0123' }] },
    1: { status: 'failed', error: '通信エラー' }
  } });
  assert.deepEqual(rows, [['元ファイル', 'folder/sample.pdf'], ['項目', '内容'], ['── 1ページ目 ──', ''], ['電話', '0123'], ['── 2ページ目 ──', ''], ['OCR失敗', '通信エラー'], ['── 3ページ目 ──', ''], ['未処理', '']]);
});

test('oversized cell text is split without losing any characters', () => {
  const text = 'あ'.repeat(70000);
  const rows = core.sheetRows({ path: 'test.png', pageCount: 1, pages: { 0: { status: 'done', rows: [{ label: '本文', content: text }] } } }).slice(2);
  assert.equal(rows.map(row => row[1]).join(''), text);
  assert(rows.every(row => row[1].length <= 32767));
});

test('PDF conversion releases page and canvas resources even when rendering fails', async () => {
  let cleaned = 0;
  const canvas = { width: 100, height: 100, getContext: () => ({}), toBlob: callback => callback(new Blob(['image'], { type: 'image/jpeg' })) };
  global.document = { createElement: () => canvas };
  const page = { getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }), cleanup: () => cleaned++ };
  const pdf = { getPage: async () => page };
  assert.equal((await core.renderPage(pdf, 1)).type, 'image/jpeg');
  assert.equal(canvas.width, 0);
  assert.equal(cleaned, 1);
  page.render = () => ({ promise: Promise.reject(new Error('render failure')) });
  await assert.rejects(core.renderPage(pdf, 1), /render failure/);
  assert.equal(cleaned, 2);
  assert.equal(canvas.height, 0);
});
