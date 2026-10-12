import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderPdfPage } from './pdfRuntime';

export function PdfPage({ pdf, number, scale, rotation, scrollRoot, onVisible, highlights = [] }: { pdf: PDFDocumentProxy; number: number; scale: number; rotation: number; scrollRoot: RefObject<HTMLDivElement>; onVisible: (page: number) => void; highlights?: { x: number; y: number; width: number; height: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 612, height: 792 });
  const [error, setError] = useState('');
  const [hasText, setHasText] = useState(true);
  const [effectiveRotation, setEffectiveRotation] = useState(rotation);
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
    void pdf.getPage(number).then(async page => {
      if (disposed) return;
      const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      setEffectiveRotation((page.rotate + rotation) % 360);
      setDimensions({ width: viewport.width, height: viewport.height });
      rendering = renderPdfPage(page, wrapper, scale, rotation);
      const text = await rendering.promise;
      if (!disposed) setHasText(!!text);
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : '渲染失败'); });
    return () => { disposed = true; rendering?.cancel(); };
  }, [pdf, number, scale, rotation, visible]);
  return <div ref={ref} className="reader-pdf-page" data-page-number={number} aria-label={`第 ${number} 页`} style={{ width: dimensions.width * scale, height: dimensions.height * scale }}>
    {highlights.map((rect, index) => {
      const r = effectiveRotation;
      const box = r === 90 ? { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width } : r === 180 ? { ...rect, x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height } : r === 270 ? { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width } : rect;
      return <span key={index} className="reader-highlight" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />;
    })}
    {!visible && <span className="reader-page-placeholder">第 {number} 页</span>}
    {error && <p role="alert">此页无法显示：{error}</p>}
    {visible && !hasText && !error && <span className="reader-scanned">此页没有可选文字，可继续阅读或记录笔记。</span>}
  </div>;
}
