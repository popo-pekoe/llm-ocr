(function (scope) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isPdf = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isSupported = file => isPdf(file) || /^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  const mimeType = file => file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }[file.name.split('.').pop().toLowerCase()]);
  const fileKey = (file, path) => JSON.stringify([path, file.size, file.lastModified]);
  const readBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
    reader.readAsDataURL(file);
  });

  async function collectEntries(entries, includeSubfolders = true) {
    const files = [];
    async function visit(entry, nested = false) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        files.push({ file, path: entry.fullPath.replace(/^\//, '') });
      } else if (entry.isDirectory && (!nested || includeSubfolders)) {
        const reader = entry.createReader();
        // readEntries returns batches (often 100 entries); read until exhausted.
        while (true) {
          const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await visit(child, true);
        }
      }
    }
    for (const entry of entries) await visit(entry);
    return files;
  }

  async function openPdf(file) {
    const lib = scope['pdfjs-dist/build/pdf'];
    if (!lib) throw new Error('PDFライブラリを読み込めませんでした');
    lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return lib.getDocument({ data: await file.arrayBuffer() }).promise;
  }

  async function renderPage(pdf, number) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    try {
      // White background avoids transparent parts becoming black in JPEG.
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) throw new Error('PDFページを画像化できませんでした');
      return blob;
    } finally {
      page.cleanup();
      canvas.width = canvas.height = 0;
    }
  }

  async function recognizePage(file, apiKey, prompt, fetchFn = scope.fetch.bind(scope), wait = sleep) {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mimeType(file), data: await readBase64(file) } }] }],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT', required: ['rows'], properties: {
            rows: { type: 'ARRAY', items: { type: 'OBJECT', required: ['label', 'content'], properties: { label: { type: 'STRING' }, content: { type: 'STRING' } } } }
          }
        }
      }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      let response, data;
      try {
        response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
        });
        if (typeof response.json === 'function') data = await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('API応答が90秒以内に返りませんでした。必要なら再実行してください');
        throw error;
      } finally { clearTimeout(timer); }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const retryAfter = Number(response.headers?.get('Retry-After')) || 0;
          const delay = response.status === 429 ? Math.max(15000 * 2 ** attempt, retryAfter * 1000) : 2000 * 2 ** attempt;
          await wait(Math.min(delay, 60000));
          continue;
        }
        const error = new Error(`APIエラー ${response.status}${response.status === 429 ? '（利用上限に達しました。時間をおいて再開してください）' : ''}`);
        error.status = response.status;
        error.fatal = data?.error?.details?.some(detail => detail.reason === 'API_KEY_INVALID') || false;
        throw error;
      }
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error(`OCRが完了しませんでした: ${candidate.finishReason}`);
      const text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('');
      const result = JSON.parse(text || '{}');
      if (!Array.isArray(result.rows) || result.rows.some(row => !row || typeof row.label !== 'string' || typeof row.content !== 'string')) throw new Error('OCR結果の形式が不正です');
      return result.rows;
    }
  }

  function sheetName(path, used) {
    const name = path.split('/').pop().replace(/\.[^.]+$/, '').replace(/[\\/?*\[\]:\x00-\x1f]/g, '_').replace(/^'+|'+$/g, '').trim() || '書類';
    const base = name.toLowerCase() === 'history' ? 'History_' : name;
    let candidate = base.slice(0, 31), n = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = `_${n++}`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function sheetRows(job) {
    const rows = [['元ファイル', job.path], ['項目', '内容']];
    for (let i = 0; i < job.pageCount; i++) {
      if (job.pageCount > 1) rows.push([`── ${i + 1}ページ目 ──`, '']);
      const page = job.pages[i];
      if (page?.status === 'done') {
        if (!page.rows.length) rows.push(['', '（文字なし）']);
        for (const row of page.rows) {
          // Excel cells hold up to 32,767 characters; preserve oversized text in continuation rows.
          const count = Math.max(1, Math.ceil(row.label.length / 32767), Math.ceil(row.content.length / 32767));
          for (let part = 0; part < count; part++) rows.push([row.label.slice(part * 32767, (part + 1) * 32767), row.content.slice(part * 32767, (part + 1) * 32767)]);
        }
      } else rows.push([page?.status === 'failed' ? 'OCR失敗' : '未処理', page?.error || '']);
    }
    return rows;
  }

  scope.BatchOCR = { sleep, isPdf, isSupported, mimeType, fileKey, readBase64, collectEntries, openPdf, renderPage, recognizePage, sheetName, sheetRows };
  if (typeof module !== 'undefined') module.exports = scope.BatchOCR;
})(typeof window === 'undefined' ? globalThis : window);
