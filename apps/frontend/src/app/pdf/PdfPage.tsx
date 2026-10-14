import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderPdfPage } from './pdfRuntime';
import { PdfRegionSelection } from './PdfRegionSelection';
import { pdfRegionToDisplay, type PdfNormalizedRegion } from './pdfSelection';

export function PdfPage({ pdf, number, scale, rotation, scrollRoot, onVisible, highlights = [],regionMode=false,region,onRegionSelect,onRegionExit,onEnableRegion }: { pdf: PDFDocumentProxy; number: number; scale: number; rotation: number; scrollRoot: RefObject<HTMLDivElement>; onVisible: (page: number) => void; highlights?: PdfNormalizedRegion[];regionMode?:boolean;region?:PdfNormalizedRegion;onRegionSelect?:(page:number,region:PdfNormalizedRegion,rotation:number)=>void;onRegionExit?:()=>void;onEnableRegion?:()=>void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 });
  const [error, setError] = useState('');
  const [hasText, setHasText] = useState(true);
  const [effectiveRotation, setEffectiveRotation] = useState(rotation);
  const [ready,setReady]=useState(false);
  useEffect(() => {
    const node = ref.current; if (!node) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { root: scrollRoot.current, rootMargin: '800px 0px' });
    const reading = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) onVisible(number); }, { root: scrollRoot.current, rootMargin: '0px 0px -70% 0px', threshold: 0 });
    observer.observe(node); reading.observe(node);
    return () => { observer.disconnect(); reading.disconnect(); };
  }, [number, onVisible, scrollRoot]);
  useEffect(() => {
    if (!visible || !ref.current) return;
    const wrapper = ref.current;
    let disposed = false;
    let rendering: ReturnType<typeof renderPdfPage> | undefined;
    setError('');
    setReady(false);
    void pdf.getPage(number).then(async page => {
      if (disposed) return;
      const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      setEffectiveRotation((page.rotate + rotation) % 360);
      setDimensions({ width: viewport.width, height: viewport.height });
      rendering = renderPdfPage(page, wrapper, scale, rotation);
      const text = await rendering.promise;
      if (!disposed) {setHasText(!!text);setReady(true);}
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : '渲染失败'); });
    return () => { disposed = true; rendering?.cancel(); };
  }, [pdf, number, scale, rotation, visible]);
  return <div ref={ref} className="reader-pdf-page" data-page-number={number} aria-label={`第 ${number} 页`} style={{ width: dimensions.width * scale, height: dimensions.height * scale }}>
    {highlights.map((rect, index) => {
      const box = pdfRegionToDisplay(rect,effectiveRotation);
      return <span key={index} className="reader-highlight" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />;
    })}
    {!visible && <span className="reader-page-placeholder">第 {number} 页</span>}
    {error && <p role="alert">此页无法显示：{error}</p>}
    {region&&(()=>{const box=pdfRegionToDisplay(region,effectiveRotation);return <span className="pdf-region-mark" style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.width*100}%`,height:`${box.height*100}%`}}/>;})()}
    {visible&&ready&&regionMode&&onRegionSelect&&<PdfRegionSelection key={`${number}:${effectiveRotation}:${scale}`} page={number} rotation={effectiveRotation} onSelect={(rect,totalRotation)=>onRegionSelect(number,rect,totalRotation)} onExit={()=>onRegionExit?.()}/>}
    {visible && !hasText && !error && <span className="reader-scanned">此页没有可选文字。{onEnableRegion?<button type="button" onClick={event=>{event.stopPropagation();onEnableRegion();}}>启用框选识别</button>:'可继续阅读或记录笔记。'}</span>}
  </div>;
}
