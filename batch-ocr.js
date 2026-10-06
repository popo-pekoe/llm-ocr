(function (scope) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isPdf = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isSupported = file => isPdf(file) || /^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  const mimeType = file => {
    const type = (file.type || '').toLowerCase();
    if (['image/jpg', 'image/pjpeg'].includes(type)) return 'image/jpeg';
    if (type.startsWith('image/')) return type;
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' }[(file.name || '').split('.').pop().toLowerCase()];
  };
  const fileKey = (file, path) => JSON.stringify([path, file.size, file.lastModified]);
  const readBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
    reader.readAsDataURL(file);
  });

  async function prepareImage(file) {
    // Work on a temporary image; retain the original File for subsequent attempts.
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType(file))) return file;
    let image, release;
    try {
      if (scope.createImageBitmap) {
        image = await scope.createImageBitmap(file, { imageOrientation: 'from-image' });
        release = () => image.close();
      } else {
        const url = URL.createObjectURL(file);
        release = () => URL.revokeObjectURL(url);
        image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('画像を読み込めませんでした'));
          image.src = url;
        });
      }
      const width = image.width, height = image.height;
      if (!width || !height) throw new Error('画像の寸法を取得できませんでした');
      const scale = Math.min(1, 2800 / Math.max(width, height));
      if (scale === 1 && (file.size || 0) <= 4 * 1024 * 1024) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      try {
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        if (!blob) throw new Error('OCR用の画像を作成できませんでした');
        return blob;
      } finally { canvas.width = canvas.height = 0; }
    } finally { if (release) release(); }
  }

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
    const image = await prepareImage(file);
    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mimeType(image), data: await readBase64(image) } }] }],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT', required: ['rows'], properties: {
            rows: { type: 'ARRAY', items: { type: 'OBJECT', required: ['label', 'content'], properties: {
              label: { type: 'STRING' }, content: { type: 'STRING' },
              cells: { type: 'ARRAY', items: { type: 'STRING' } },
              table_id: { type: 'STRING' }, is_header: { type: 'BOOLEAN' }
            } } }
          }
        }
      }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);
      let response, data;
      try {
        response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
        });
        if (typeof response.json === 'function') data = await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('API応答が180秒以内に返りませんでした。時間をおいて失敗分を再実行してください');
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
      if (result.rows.some(row => (row.cells !== undefined && (!Array.isArray(row.cells) || row.cells.some(cell => typeof cell !== 'string'))) || (row.table_id !== undefined && typeof row.table_id !== 'string') || (row.is_header !== undefined && typeof row.is_header !== 'boolean'))) throw new Error('表のOCR結果の形式が不正です');
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

  function sheetLayout(job) {
    const rows = [['元ファイル', job.path], ['項目', '内容']];
    const tables = [];
    for (let i = 0; i < job.pageCount; i++) {
      let table = null;
      if (job.pageCount > 1) rows.push([`── ${i + 1}ページ目 ──`, '']);
      const page = job.pages[i];
      if (page?.status === 'done') {
        if (!page.rows.length) rows.push(['', '（文字なし）']);
        for (const row of page.rows) {
          if (row.cells?.length) {
            const id = row.table_id || '';
            if (!table || table.id !== id) {
              if (table) rows.push(['', '']);
              table = { id, start: rows.length, end: rows.length, columns: 0, headers: [] };
              tables.push(table);
            }
            table.columns = Math.max(table.columns, row.cells.length);
            if (row.is_header) table.headers.push(rows.length);
            const count = Math.max(1, ...row.cells.map(cell => Math.ceil(cell.length / 32767)));
            for (let part = 0; part < count; part++) rows.push(row.cells.map(cell => cell.slice(part * 32767, (part + 1) * 32767)));
            table.end = rows.length - 1;
            continue;
          }
          table = null;
          // Excel cells hold up to 32,767 characters; preserve oversized text in continuation rows.
          const count = Math.max(1, Math.ceil(row.label.length / 32767), Math.ceil(row.content.length / 32767));
          for (let part = 0; part < count; part++) rows.push([row.label.slice(part * 32767, (part + 1) * 32767), row.content.slice(part * 32767, (part + 1) * 32767)]);
        }
      } else rows.push([page?.status === 'failed' ? 'OCR失敗' : '未処理', page?.error || '']);
    }
    // Pad short rows so blank cells receive the same grid borders as populated cells.
    for (const table of tables) {
      for (let r = table.start; r <= table.end; r++) while (rows[r].length < table.columns) rows[r].push('');
    }
    return { rows, tables };
  }

  const sheetRows = job => sheetLayout(job).rows;

  function createSheet(job, xlsx) {
    const { rows, tables } = sheetLayout(job);
    const sheet = xlsx.utils.aoa_to_sheet(rows);
    const columns = Math.max(2, ...tables.map(table => table.columns));
    const widths = Array.from({ length: columns }, (_, c) => columns === 2 ? (c === 0 ? 28 : 100) : (c === 0 ? 28 : 24));
    const tableRows = new Set();
    const lineWidth = text => Array.from(text).reduce((sum, ch) => sum + (ch.codePointAt(0) > 255 ? 2 : 1), 0);
    sheet['!cols'] = widths.map(wch => ({ wch }));
    sheet['!rows'] = [];
    sheet['!merges'] = [];
    const edge = { style: 'thin', color: { rgb: '808080' } };
    for (const table of tables) {
      for (let r = table.start; r <= table.end; r++) {
        tableRows.add(r);
        for (let c = 0; c < table.columns; c++) {
          const address = xlsx.utils.encode_cell({ r, c });
          sheet[address] ||= { t: 's', v: '' };
          sheet[address].s = { border: { top: edge, bottom: edge, left: edge, right: edge } };
          if (table.headers.includes(r)) Object.assign(sheet[address].s, { font: { name: 'Yu Gothic', sz: 11, bold: true }, fill: { patternType: 'solid', fgColor: { rgb: 'F1F5F9' } } });
        }
      }
    }
    rows.forEach((row, r) => {
      const isTable = tableRows.has(r);
      if (!isTable && columns > 2) sheet['!merges'].push({ s: { r, c: 1 }, e: { r, c: columns - 1 } });
      let lines = 1;
      row.forEach((value, c) => {
        const cell = sheet[xlsx.utils.encode_cell({ r, c })];
        if (cell) cell.s = { font: { name: 'Yu Gothic', sz: 11 }, ...cell.s, alignment: { vertical: 'top', wrapText: true } };
        const width = !isTable && c === 1 ? widths.slice(1).reduce((sum, w) => sum + w, 0) : widths[c];
        lines = Math.max(lines, String(value).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(lineWidth(line) / Math.max(1, width - 2))), 0));
      });
      sheet['!rows'][r] = { hpt: Math.min(409, Math.max(22, lines * 16 + 6)) };
    });
    return sheet;
  }

  scope.BatchOCR = { sleep, isPdf, isSupported, mimeType, fileKey, readBase64, prepareImage, collectEntries, openPdf, renderPage, recognizePage, sheetName, sheetRows, sheetLayout, createSheet };
  if (typeof module !== 'undefined') module.exports = scope.BatchOCR;
})(typeof window === 'undefined' ? globalThis : window);
