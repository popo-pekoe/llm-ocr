const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../batch-ocr.js');

global.FileReader = class {
  readAsDataURL() { this.result = 'data:image/png;base64,dGVzdA=='; this.onload(); }
};
global.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
const ok = rows => ({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ rows }) }] } }] }) });

test('OCR preserves labels, multiline content, and individual table cells', async () => {
  const rows = [{ label: '住所', content: '東京都\n1-2-3' }, { label: '', content: '', cells: ['品名', '数量', '金額'], table_id: '1', is_header: true }, { label: '', content: '', cells: ['部材', '', '1,000'], table_id: '1', is_header: false }];
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
  await assert.rejects(core.recognizePage({ type: 'image/png' }, 'test', '', async () => ok([{ label: '', content: '', cells: ['数量', 123] }])), /形式/);
  assert.deepEqual(await core.recognizePage({ type: 'image/png' }, 'test', '', async () => ok([])), []);
});

test('tables retain cells, blank columns, headers, and separate table ranges', () => {
  const job = { path: 'test.pdf', pageCount: 1, pages: { 0: { status: 'done', rows: [
    { label: '名前', content: '山田' },
    { label: '', content: '', cells: ['品名', '数量', '金額'], table_id: 'a', is_header: true },
    { label: '', content: '', cells: ['部材', '', '1,000'], table_id: 'a' },
    { label: '', content: '', cells: ['備考'], table_id: 'a' },
    { label: '', content: '', cells: ['日付', '内容'], table_id: 'b' },
    { label: '注意事項', content: '原文のまま\n折り返し' }
  ] } } };
  const layout = core.sheetLayout(job);
  assert.deepEqual(layout.rows[3], ['品名', '数量', '金額']);
  assert.deepEqual(layout.rows[4], ['部材', '', '1,000']);
  assert.deepEqual(layout.rows[5], ['備考', '', '']);
  assert.equal(layout.tables.length, 2);
  assert.deepEqual(layout.tables[0], { id: 'a', start: 3, end: 5, columns: 3, headers: [3] });
  assert.deepEqual(layout.tables[1], { id: 'b', start: 7, end: 7, columns: 2, headers: [] });
});

test('worksheet formatting borders every table cell and only merges text outside tables', () => {
  const job = { path: 'test.png', pageCount: 1, pages: { 0: { status: 'done', rows: [
    { label: '電話番号', content: '0123' },
    { label: '', content: '', cells: ['品名', '数量', '金額'], is_header: true },
    { label: '', content: '', cells: ['=1+1', '', '1,000'] }
  ] } } };
  const xlsx = { utils: {
    encode_cell: ({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`,
    aoa_to_sheet: rows => Object.fromEntries(rows.flatMap((row, r) => row.map((v, c) => [`${String.fromCharCode(65 + c)}${r + 1}`, { t: 's', v }])))
  } };
  const sheet = core.createSheet(job, xlsx);
  assert.equal(sheet.A4.v, '品名');
  assert.equal(sheet.A4.s.font.bold, true);
  for (const address of ['A4', 'B4', 'C4', 'A5', 'B5', 'C5']) {
    for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(sheet[address].s.border[side].style, 'thin');
    assert.equal(sheet[address].s.alignment.wrapText, true);
  }
  assert.equal(sheet.B5.v, '');
  assert.equal(sheet.B3.v, '0123');
  assert.equal(sheet.A5.v, '=1+1');
  assert.equal(sheet.A5.t, 's');
  assert(sheet['!merges'].every(merge => merge.s.r < 3));
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

test('large JPEG images are resized with their aspect ratio and released after encoding', async () => {
  const previousBitmap = global.createImageBitmap, previousDocument = global.document;
  let closed = 0, dimensions, encoded;
  const original = { type: 'image/jpeg', size: 632401 };
  const output = new Blob(['resized'], { type: 'image/jpeg' });
  const canvas = { getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (resolve, type, quality) => { dimensions = [canvas.width, canvas.height]; encoded = [type, quality]; resolve(output); } };
  global.createImageBitmap = async (file, options) => { assert.equal(file, original); assert.equal(options.imageOrientation, 'from-image'); return { width: 2541, height: 3499, close: () => closed++ }; };
  global.document = { createElement: () => canvas };
  try {
    assert.equal(await core.prepareImage(original), output);
    assert.deepEqual(dimensions, [2033, 2800]);
    assert.deepEqual(encoded, ['image/jpeg', 0.9]);
    assert.equal(closed, 1);
    assert.equal(canvas.width, 0);
    assert.equal(original.size, 632401);
  } finally { global.createImageBitmap = previousBitmap; global.document = previousDocument; }
});

test('small images are kept as originals; MIME aliases are normalized', async () => {
  const file = { name: 'small.jpg', type: 'image/pjpeg', size: 1000 };
  assert.equal(core.mimeType(file), 'image/jpeg');
  assert.equal(core.mimeType({ name: 'scan.JPG', type: 'application/octet-stream' }), 'image/jpeg');
  assert.equal(await core.prepareImage(file), file);
});

test('API requests allow 180 seconds and do not silently resend timed-out OCR', async () => {
  const previousSetTimeout = global.setTimeout, previousClearTimeout = global.clearTimeout;
  const timers = []; let calls = 0;
  global.setTimeout = (_, delay) => { timers.push(delay); return 1; };
  global.clearTimeout = () => {};
  try {
    await assert.rejects(core.recognizePage({ type: 'image/jpeg', size: 1000 }, 'test', '', async () => { calls++; const error = new Error('aborted'); error.name = 'AbortError'; throw error; }), /180秒/);
    assert.deepEqual(timers, [180000]);
    assert.equal(calls, 1);
  } finally { global.setTimeout = previousSetTimeout; global.clearTimeout = previousClearTimeout; }
});
