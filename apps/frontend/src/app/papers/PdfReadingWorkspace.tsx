import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, List, RotateCw, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { PdfPage } from '../pdf/PdfPage';
import { usePdfDocument } from '../pdf/usePdfDocument';
import { capturePdfSelection } from '../pdf/pdfSelection';
import { attachmentUrl, type PaperAttachment, type ReadingSelection } from '../../api/paperReaderAdapter';
import { TranslationPanel } from './TranslationPanel';
import { usePaperAnnotations } from './usePaperAnnotations';
import { ReadingNotes } from './ReadingNotes';
import { ReadingGlossaryPanel } from './ReadingGlossaryPanel';
import { ReadingExplanationPanel } from './ReadingExplanationPanel';
import { ReadingOcrPanel } from './ReadingOcrPanel';
import type { OcrSource, OcrRotation } from '../../api/readingOcrAdapter';
import type { PdfNormalizedRegion } from '../pdf/pdfSelection';

const noVisible = () => {};
export function PdfReadingWorkspace({ projectId, paperId, attachment }: { projectId: string; paperId: string; attachment: PaperAttachment }) {
  const { pdf, outline, error } = usePdfDocument(attachmentUrl(projectId, paperId, attachment.id));
  const annotations = usePaperAnnotations(projectId, paperId);
  const [params]=useSearchParams(),linkedOcrTask=params.get('ocrTask')||undefined;
  const [panel, setPanel] = useState<'translation' | 'notes' | 'glossary' | 'explanation' | 'ocr'>(linkedOcrTask?'ocr':'translation');
  const [ocrMode,setOcrMode]=useState(false),[ocrSource,setOcrSource]=useState<OcrSource|null>(null);
  const regionVersion=useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(680);
  const [pageWidth, setPageWidth] = useState(612);
  const [zoom, setZoom] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [indexMode, setIndexMode] = useState<'none' | 'outline' | 'thumbnails' | 'search'>('none');
  const [query, setQuery] = useState('');
  const [finding, setFinding] = useState(false);
  const [matches, setMatches] = useState<{ page: number; excerpt: string }[]>([]);
  const [selection, setSelection] = useState<ReadingSelection | null>(null);
  const [notice, setNotice] = useState('');
  const findVersion = useRef(0);
  const storageKey = `scienceprism-reader:${projectId}:${paperId}:${attachment.sha256}`;
  const scale = zoom || Math.min(2, Math.max(.25, (width - 48) / pageWidth));
  const goToPage = useCallback((value: number) => { const root = scrollRef.current; const target = root?.querySelector(`[data-page-number="${value}"]`); if (root && target) root.scrollTo({ top: root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 24, behavior: 'instant' }); setPage(value); }, []);
  const onVisible = useCallback((value: number) => setPage(value), []);
  const exitRegion=useCallback(()=>{regionVersion.current++;setOcrMode(false);},[]);
  const enableRegion=()=>{window.getSelection()?.removeAllRanges();setOcrMode(true);setPanel('ocr');setNotice('');};
  const selectRegion=(number:number,region:PdfNormalizedRegion,totalRotation:number)=>{regionVersion.current++;setOcrSource({attachmentId:attachment.id,fileSha256:attachment.sha256,page:number,region,rotation:totalRotation as OcrRotation});setOcrMode(false);setPanel('ocr');setNotice('');};
  const selectCurrentPage=async()=>{if(!pdf)return;const current=++regionVersion.current;try{const item=await pdf.getPage(page);if(current===regionVersion.current)selectRegion(page,{x:0,y:0,width:1,height:1},(item.rotate+rotation)%360);}catch{if(current===regionVersion.current)setNotice('当前页无法读取，请稍后重新打开附件。');}};
  useEffect(()=>{if(linkedOcrTask)setPanel('ocr');},[linkedOcrTask]);
  useEffect(()=>{if(!ocrMode)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();exitRegion();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[ocrMode,exitRegion]);
  useEffect(() => {
    const node = scrollRef.current; if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth)); observer.observe(node);
    return () => observer.disconnect();
  }, [pdf]);
  useEffect(() => {
    if (!pdf) return;
    let disposed = false;
    void pdf.getPage(1).then(item => { if (!disposed) setPageWidth(item.getViewport({ scale: 1, rotation: (item.rotate + rotation) % 360 }).width); }).catch(() => { if (!disposed) setNotice('无法读取页面尺寸，可稍后重新打开附件。'); });
    return () => { disposed = true; };
  }, [pdf, rotation]);
  useEffect(() => {
    if (!pdf) return;
    let saved = 1;
    try { saved = Number(localStorage.getItem(storageKey)) || 1; } catch { /* Storage is optional. */ }
    const timer = setTimeout(() => goToPage(Math.max(1, Math.min(pdf.numPages, saved))), 100);
    return () => { clearTimeout(timer); findVersion.current++; };
  }, [pdf, storageKey, goToPage]);
  useEffect(() => { if (!pdf) return; const timer = setTimeout(() => { try { localStorage.setItem(storageKey, String(page)); } catch { /* Reading works without storage. */ } }, 400); return () => clearTimeout(timer); }, [page, pdf, storageKey]);
  const select = () => {
    if(ocrMode)return;
    if (!scrollRef.current) return;
    const captured = capturePdfSelection(scrollRef.current, attachment.id, attachment.sha256);
    if (captured.selection) { setSelection(previous => previous?.text === captured.selection!.text && previous.page === captured.selection!.page && previous.fileSha256 === captured.selection!.fileSha256 && JSON.stringify(previous.rects) === JSON.stringify(captured.selection!.rects) ? previous : captured.selection!); setPanel(value=>value==='notes'?'translation':value); setNotice(''); }
    else if (captured.message) setNotice(captured.message);
  };
  const find = async () => {
    const version = ++findVersion.current;
    setMatches([]); setIndexMode('search');
    if (!pdf || !query.trim()) { setFinding(false); return; }
    setFinding(true);
    const found: { page: number; excerpt: string }[] = [];
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        if (version !== findVersion.current) return;
        const item = await pdf.getPage(number);
        const content = await item.getTextContent();
        if (version !== findVersion.current) return;
        const text = content.items.map(item => 'str' in item ? item.str : '').join(' ');
        const offset = text.toLowerCase().indexOf(query.trim().toLowerCase());
        if (offset >= 0) { found.push({ page: number, excerpt: text.slice(Math.max(0, offset - 40), offset + query.length + 100) }); setMatches([...found]); }
        if (found.length >= 200) break;
      }
    } catch { if (version === findVersion.current) setNotice('部分页面未能检索，已找到的结果保留。'); }
    finally { if (version === findVersion.current) setFinding(false); }
  };
  return <div className="reader-workspace">
    <div className="reader-document">
      <div className="reader-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <button aria-label="目录与缩略图" aria-expanded={indexMode !== 'none'} onClick={() => setIndexMode(value => value === 'none' ? 'outline' : 'none')}><List size={17} /></button>
        <button aria-label="上一页" disabled={page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft size={17} /></button><label className="reader-page-control"><input aria-label="页码" type="number" min={1} max={pdf?.numPages || 1} value={page} onChange={event => { const value = Number(event.target.value); if (pdf && value >= 1 && value <= pdf.numPages) goToPage(value); }} /> / {pdf?.numPages || '—'}</label><button aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => goToPage(page + 1)}><ChevronRight size={17} /></button>
        <span className="reader-toolbar-divider" />
        <button aria-label="缩小" disabled={scale <= .3} onClick={() => setZoom(Math.max(.25, scale - .15))}><ZoomOut size={17} /></button><button aria-label="适合页宽" onClick={() => setZoom(0)}>{Math.round(scale * 100)}%</button><button aria-label="放大" disabled={scale >= 3} onClick={() => setZoom(Math.min(3, scale + .15))}><ZoomIn size={17} /></button><button aria-label="顺时针旋转" onClick={() => { setRotation(value => (value + 90) % 360); setSelection(null);setOcrSource(null);exitRegion(); }}><RotateCw size={17} /></button><button disabled={!pdf} aria-pressed={ocrMode} onClick={()=>ocrMode?exitRegion():enableRegion()}>框选识别</button>
        <form className="reader-find" onSubmit={event => { event.preventDefault(); void find(); }}><input aria-label="在 PDF 中查找" placeholder="查找文字" value={query} onChange={event => setQuery(event.target.value)} /><button aria-label="查找" disabled={!pdf || !query.trim()}><Search size={16} /></button></form>
      </div>
      {notice && <p role="status" className="reader-inline-notice">{notice}</p>}
      {ocrMode&&<div className="reader-ocr-mode-note"><span>拖框选择区域，或用键盘选择当前整页。Esc退出。</span><div><button disabled={!pdf} onClick={()=>void selectCurrentPage()}>选择当前整页</button><button onClick={exitRegion}>退出框选</button></div></div>}
      <div className="reader-document-body">
        {indexMode !== 'none' && <aside className="reader-document-index" ref={indexRef} aria-label="文档导航"><div className="reader-index-tabs"><button aria-pressed={indexMode === 'outline'} onClick={() => setIndexMode('outline')}>目录</button><button aria-pressed={indexMode === 'thumbnails'} onClick={() => setIndexMode('thumbnails')}>缩略图</button><button aria-pressed={indexMode === 'search'} onClick={() => setIndexMode('search')}>查找</button></div>
          {indexMode === 'outline' && (outline.length ? outline.map((item, index) => <button className="reader-outline-item" key={index} disabled={!item.page} style={{ paddingLeft: 12 + Math.min(item.level, 4) * 10 }} onClick={() => item.page && goToPage(item.page)}>{item.title}</button>) : <p className="reader-muted">此 PDF 没有目录，可使用页码或缩略图。</p>)}
          {indexMode === 'thumbnails' && pdf && Array.from({ length: pdf.numPages }, (_, index) => <button className="reader-thumbnail" aria-label={`打开第 ${index + 1} 页`} key={index} onClick={() => goToPage(index + 1)}><PdfPage pdf={pdf} number={index + 1} scale={120 / pageWidth} rotation={rotation} scrollRoot={indexRef} onVisible={noVisible} /><span>{index + 1}</span></button>)}
          {indexMode === 'search' && <><p className="reader-muted">{finding ? `检索中，已找到 ${matches.length} 页` : `找到 ${matches.length} 页${matches.length === 200 ? '（最多显示 200 页）' : ''}`}</p>{finding && <button onClick={() => { findVersion.current++; setFinding(false); }}>停止查找</button>}{matches.map(match => <button className="reader-search-match" key={match.page} onClick={() => goToPage(match.page)}><strong>第 {match.page} 页</strong><span>{match.excerpt}</span></button>)}</>}
        </aside>}
        <div className="reader-pages" ref={scrollRef} onPointerUp={select} onKeyUp={select} tabIndex={0} aria-label="PDF 原文">
          {error && <p role="alert" className="reader-error">PDF 无法打开：{error}</p>}{!pdf && !error && <p role="status">正在打开本地 PDF…</p>}
          {pdf && Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index + 1} pdf={pdf} number={index + 1} scale={scale} rotation={rotation} scrollRoot={scrollRef} onVisible={onVisible} regionMode={ocrMode} region={ocrSource?.page===index+1?ocrSource.region:undefined} onRegionSelect={selectRegion} onRegionExit={exitRegion} onEnableRegion={()=>{goToPage(index+1);enableRegion();}} highlights={(annotations.data?.annotations || []).filter(note => note.locationStatus === 'anchored' && note.anchor?.fileSha256 === attachment.sha256 && note.anchor.page === index + 1).flatMap(note => note.anchor!.rects)} />)}
        </div>
      </div>
    </div>
    <aside className="reader-right-panel"><nav className="reader-panel-tabs" aria-label="阅读面板"><button aria-pressed={panel === 'translation'} onClick={() => setPanel('translation')}>翻译</button><button aria-pressed={panel === 'notes'} onClick={() => setPanel('notes')}>批注与笔记</button><button aria-pressed={panel === 'glossary'} onClick={()=>setPanel('glossary')}>术语</button><button aria-pressed={panel === 'explanation'} onClick={()=>setPanel('explanation')}>解释</button><button aria-pressed={panel==='ocr'} onClick={()=>setPanel('ocr')}>OCR</button></nav><div hidden={panel !== 'translation'}><TranslationPanel projectId={projectId} paperId={paperId} selection={selection} onLocate={goToPage} onSave={annotations.save} /></div><div hidden={panel !== 'notes'}><ReadingNotes controller={annotations} hash={attachment.sha256} onLocate={goToPage} /></div><div hidden={panel !== 'glossary'}><ReadingGlossaryPanel projectId={projectId} paperId={paperId} attachmentId={attachment.id} fileSha256={attachment.sha256} selection={selection} onLocate={goToPage}/></div><div hidden={panel !== 'explanation'}><ReadingExplanationPanel projectId={projectId} paperId={paperId} attachmentId={attachment.id} fileSha256={attachment.sha256} selection={selection} onLocate={goToPage} active={panel==='explanation'}/></div><div hidden={panel!=='ocr'}><ReadingOcrPanel projectId={projectId} paperId={paperId} attachment={attachment} pdf={pdf} source={ocrSource} onLocate={goToPage} active={panel==='ocr'} linkedTaskId={linkedOcrTask}/></div></aside>
  </div>;
}
