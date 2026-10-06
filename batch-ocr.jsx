function BatchOcrPanel({ open, apiKey, onClose, onSettings }) {
  const { useState, useRef } = React;
  const core = window.BatchOCR;
  const [jobs, setJobs] = useState([]);
  const jobsRef = useRef([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState('');
  const [active, setActive] = useState('');
  const [previewId, setPreviewId] = useState(null);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const [registering, setRegistering] = useState(false);
  const registeringRef = useRef(false);

  const updateJobs = transform => {
    jobsRef.current = transform(jobsRef.current);
    setJobs(jobsRef.current);
  };
  const updateJob = (id, transform) => updateJobs(list => list.map(job => job.id === id ? transform(job) : job));
  const setPage = (id, index, page) => updateJob(id, job => ({ ...job, pages: { ...job.pages, [index]: page } }));

  async function registerFiles(items) {
    if (busyRef.current || registeringRef.current) return;
    registeringRef.current = true;
    setRegistering(true);
    setMessage('ファイルを登録しています…');
    let added = 0, duplicates = 0, skipped = 0;
    const errors = [];
    try {
      for (const { file, path } of items.sort((a, b) => a.path.localeCompare(b.path, 'ja', { numeric: true }))) {
        if (!core.isSupported(file)) { skipped++; continue; }
        const id = core.fileKey(file, path);
        if (jobsRef.current.some(job => job.id === id)) { duplicates++; continue; }
        let pdf;
        try {
          let pageCount = 1;
          if (core.isPdf(file)) { pdf = await core.openPdf(file); pageCount = pdf.numPages; }
          updateJobs(list => [...list, { id, file, path, pageCount, pages: {} }]);
          added++;
        } catch (error) { errors.push(`${path}: ${error.message}`); }
        finally { if (pdf) await pdf.destroy(); }
      }
      setMessage(`${added}ファイル追加${duplicates ? `・重複${duplicates}件を除外` : ''}${skipped ? `・対象外${skipped}件を除外` : ''}${errors.length ? `。読み込み失敗: ${errors.join(' / ')}` : ''}`);
    } finally {
      registeringRef.current = false;
      setRegistering(false);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    if (busyRef.current || registeringRef.current) return;
    // Capture entries synchronously while the drop data store is readable.
    const entries = Array.from(event.dataTransfer.items || []).map(item => {
      const getEntry = item.getAsEntry || item.webkitGetAsEntry;
      return getEntry ? getEntry.call(item) : null;
    });
    const files = Array.from(event.dataTransfer.files);
    registeringRef.current = true;
    setRegistering(true);
    try {
      const items = entries.length && entries.every(Boolean)
        ? await core.collectEntries(entries, true)
        : files.map(file => ({ file, path: file.name }));
      registeringRef.current = false;
      await registerFiles(items);
    } catch (error) { setMessage(`フォルダを読み込めませんでした: ${error.message}`); }
    finally { registeringRef.current = false; setRegistering(false); }
  }

  const prompt = 'この画像の全文を、原文の順番を保って項目ごとに文字起こししてください。要約・言い換え・推測・省略をしないでください。名前、住所、電話番号など、ラベルがある項目はlabelに原文の項目名、contentに内容を入れて1項目1行にしてください。住所や説明文の途中の改行は同じcontent内に残してください。見出しに続く説明文は見出しと本文で1行にしてください。見出しのない文章は空行や区切り線を目安に段落ごとに1行とし、labelは空文字にしてください。箇条書きは1件1行にしてください。表は見出し行も含め原稿の各行を1行ずつ出力し、labelは空文字、contentには全ての列の値を左から順に「 | 」で区切って入れてください。空欄の列も区切りを残し、列の順番と行の順番を保ってください。表にない列名や値を追加しないでください。表の枠線は文字にせず、文章を区切る横線は独立した行のcontentに「────────」として残してください。文字がない画像はrowsを空配列にしてください。';

  async function start() {
    if (busyRef.current || registeringRef.current || !jobsRef.current.length) return;
    if (!apiKey) { onSettings(); return; }
    busyRef.current = true;
    stopRef.current = false;
    setStopping(false);
    setBusy(true);
    setMessage('OCRを実行しています。完了したページは再送信しません。');
    let failures = 0;
    try {
      for (const original of [...jobsRef.current]) {
        if (stopRef.current) break;
        const job = jobsRef.current.find(item => item.id === original.id);
        if (Object.values(job.pages).filter(page => page.status === 'done').length === job.pageCount) continue;
        let pdf;
        try {
          if (core.isPdf(job.file)) pdf = await core.openPdf(job.file);
          for (let index = 0; index < job.pageCount; index++) {
            if (stopRef.current) break;
            if (jobsRef.current.find(item => item.id === job.id).pages[index]?.status === 'done') continue;
            setActive(`${job.path} — ${index + 1}/${job.pageCount}ページ`);
            setPage(job.id, index, { status: 'processing' });
            try {
              const image = pdf ? await core.renderPage(pdf, index + 1) : job.file;
              const rows = await core.recognizePage(image, apiKey, prompt);
              setPage(job.id, index, { status: 'done', rows });
            } catch (error) {
              failures++;
              setPage(job.id, index, { status: 'failed', error: error.message });
              // Authentication / quota problems affect the whole queue.
              if (error.fatal || [401, 403, 429].includes(error.status)) {
                stopRef.current = true;
                setMessage(`処理を停止しました: ${error.message}。設定や利用上限を確認して再開してください。`);
              }
            }
            if (!stopRef.current) await core.sleep(1000);
          }
        } catch (error) {
          failures++;
          for (let index = 0; index < job.pageCount; index++) {
            if (jobsRef.current.find(item => item.id === job.id).pages[index]?.status !== 'done') setPage(job.id, index, { status: 'failed', error: error.message });
          }
        } finally { if (pdf) await pdf.destroy(); }
      }
      if (!stopRef.current) setMessage(`処理が終了しました${failures ? '。失敗したページは「未処理・失敗分をOCR」で再実行できます。' : '。Excelに保存できます。'}`);
    } catch (error) { setMessage(`処理エラー: ${error.message}`); }
    finally { busyRef.current = false; setBusy(false); setStopping(false); setActive(''); }
  }

  function exportWorkbook() {
    try {
      if (typeof XLSX === 'undefined') throw new Error('Excelライブラリを読み込めませんでした');
      const workbook = XLSX.utils.book_new();
      const used = new Set();
      for (const job of jobsRef.current) {
        const rows = core.sheetRows(job);
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        sheet['!cols'] = [{ wch: 28 }, { wch: 100 }];
        XLSX.utils.book_append_sheet(workbook, sheet, core.sheetName(job.path, used));
      }
      const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '');
      XLSX.writeFile(workbook, `${date}_一括OCR.xlsx`);
      setMessage('Excelを保存しました。未処理・失敗ページも各シートに表示しています。');
    } catch (error) { setMessage(`Excel保存エラー: ${error.message}`); }
  }

  const total = jobs.reduce((sum, job) => sum + job.pageCount, 0);
  const completed = jobs.reduce((sum, job) => sum + Object.values(job.pages).filter(page => page.status === 'done').length, 0);
  const failed = jobs.reduce((sum, job) => sum + Object.values(job.pages).filter(page => page.status === 'failed').length, 0);
  const preview = jobs.find(job => job.id === previewId);
  const locked = busy || registering;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-3">
      <section role="dialog" aria-modal="true" aria-labelledby="batch-title" className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col">
        <header className="p-4 border-b flex items-center justify-between gap-3">
          <h2 id="batch-title" className="text-lg font-bold text-emerald-800">一括テキストOCR</h2>
          <button onClick={onClose} disabled={locked} className="px-3 py-1 border rounded disabled:opacity-40">閉じる</button>
        </header>
        <div className="p-4 overflow-y-auto space-y-4">
          <p className="text-sm text-gray-600">画像・PDFを登録し、項目ごとに「項目名／内容」の2列で出力します。表の列は「 | 」で区切ります。元ファイル1つにつきExcelの1シートにまとめます。</p>
          <div onDragOver={event => event.preventDefault()} onDrop={handleDrop} className={`border-2 border-dashed rounded-lg p-5 text-center ${locked ? 'bg-gray-100 border-gray-200' : 'border-emerald-300 bg-emerald-50'}`}>
            <p className="font-medium mb-3">画像・PDF、またはフォルダをここにドロップ</p>
            <div className="flex justify-center gap-3 flex-wrap">
              <button disabled={locked} onClick={() => fileInput.current.click()} className="px-4 py-2 bg-white border rounded disabled:opacity-40">ファイルを追加</button>
              <button disabled={locked} onClick={() => folderInput.current.click()} className="px-4 py-2 bg-white border rounded disabled:opacity-40">フォルダを追加</button>
            </div>
            <p className="mt-2 text-xs text-gray-500">サブフォルダも含みます。JPEG・PNG・WebP・HEIC・HEIF・PDFに対応。</p>
            <input ref={fileInput} aria-label="一括OCRファイル選択" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif" className="hidden" onChange={event => { const files = Array.from(event.target.files); event.target.value = ''; registerFiles(files.map(file => ({ file, path: file.name }))); }} />
            <input ref={folderInput} aria-label="一括OCRフォルダ選択" type="file" multiple webkitdirectory="" directory="" className="hidden" onChange={event => { const files = Array.from(event.target.files); event.target.value = ''; registerFiles(files.map(file => ({ file, path: file.webkitRelativePath || file.name }))); }} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">{jobs.length}ファイル・{total}ページ／完了 {completed}・失敗 {failed}・未処理 {total - completed - failed}</span>
            <button onClick={start} disabled={locked || !jobs.length || completed === total} className="px-4 py-2 bg-emerald-600 text-white font-bold rounded disabled:opacity-40">{completed || failed ? '未処理・失敗分をOCR' : '一括OCRを開始'}</button>
            {busy && <button disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); setMessage('現在のページの処理が終わると停止します。'); }} className="px-4 py-2 border border-red-300 text-red-700 rounded disabled:opacity-40">{stopping ? '停止待ち…' : '停止'}</button>}
            <button onClick={exportWorkbook} disabled={locked || !jobs.length || !completed} className="px-4 py-2 bg-white border border-emerald-600 text-emerald-700 font-bold rounded disabled:opacity-40">Excelに保存</button>
            <button disabled={locked || !jobs.length} onClick={() => { updateJobs(() => []); setPreviewId(null); setMessage('登録をクリアしました。'); }} className="ml-auto text-sm text-gray-500 underline disabled:opacity-40">全てクリア</button>
          </div>
          <p className="text-xs text-gray-500">処理中は画面を開いたままにしてください。停止後は同じ画面で再開できます。再読み込みすると登録と結果は消えます。</p>
          <p aria-live="polite" className="text-sm text-emerald-800 whitespace-pre-wrap">{active && <span className="block font-bold">処理中: {active}</span>}{message}</p>
          {!!jobs.length && <div className="border rounded overflow-x-auto"><table className="w-full text-sm">
            <thead className="bg-gray-50"><tr><th className="text-left p-2">元ファイル</th><th className="p-2">ページ数</th><th className="p-2">完了／失敗</th><th className="p-2">操作</th></tr></thead>
            <tbody>{jobs.map(job => <tr key={job.id} className="border-t">
              <td className="p-2 break-all">{job.path}</td><td className="p-2 text-center">{job.pageCount}</td>
              <td className="p-2 text-center">{Object.values(job.pages).filter(page => page.status === 'done').length} ／ {Object.values(job.pages).filter(page => page.status === 'failed').length}</td>
              <td className="p-2 text-center whitespace-nowrap"><button onClick={() => setPreviewId(job.id)} className="text-emerald-700 underline mr-3">結果</button><button disabled={locked} onClick={() => { updateJobs(list => list.filter(item => item.id !== job.id)); if (previewId === job.id) setPreviewId(null); }} className="text-gray-500 underline disabled:opacity-40">削除</button></td>
            </tr>)}</tbody>
          </table></div>}
          {preview && <div className="border rounded p-3"><h3 className="font-bold mb-2 break-all">{preview.path}</h3><div className="overflow-x-auto max-h-80 overflow-y-auto"><table className="w-full text-sm"><tbody>{core.sheetRows(preview).slice(1).map((row, index) => <tr key={index} className="border-b"><td className="p-2 align-top whitespace-pre-wrap w-1/3">{row[0]}</td><td className="p-2 align-top whitespace-pre-wrap">{row[1]}</td></tr>)}</tbody></table></div></div>}
        </div>
      </section>
    </div>
  );
}
window.BatchOcrPanel = BatchOcrPanel;
