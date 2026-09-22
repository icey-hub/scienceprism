import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { GlobalWorkerOptions, getDocument, renderTextLayer } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import 'pdfjs-dist/web/pdf_viewer.css';

GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfAnnotation {
  id: string;
  page: number;
  x: number;
  y: number;
  text: string;
}

export function PdfPreview({
  pdfUrl,
  scale,
  fitWidth,
  spread,
  onFitScale,
  onTextClick,
  onOutline,
  annotations,
  annotateMode,
  onAddAnnotation,
  containerRef: externalRef
}: {
  pdfUrl: string;
  scale: number;
  fitWidth: boolean;
  spread: boolean;
  onFitScale?: (value: number | null) => void;
  onTextClick: (text: string) => void;
  onOutline?: (items: { title: string; page?: number; level: number }[]) => void;
  annotations: PdfAnnotation[];
  annotateMode: boolean;
  onAddAnnotation?: (page: number, x: number, y: number) => void;
  containerRef?: RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const localRef = useRef<HTMLDivElement | null>(null);
  const containerRef = externalRef || localRef;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfUrl) return;
    let cancelled = false;
    container.innerHTML = '';

    const render = async () => {
      try {
        const loadingTask = getDocument(pdfUrl);
        const pdf = await loadingTask.promise;
        const containerWidth = container.clientWidth - 24;
        const pageTargetWidth = spread ? Math.max(200, (containerWidth - 16) / 2) : containerWidth;
        let baseScale = scale;
        let firstPage: Awaited<ReturnType<typeof pdf.getPage>> | null = null;
        if (fitWidth && containerWidth > 0) {
          firstPage = await pdf.getPage(1);
          const originalViewport = firstPage.getViewport({ scale: 1.0 });
          baseScale = pageTargetWidth / originalViewport.width;
          onFitScale?.(baseScale);
        } else {
          onFitScale?.(null);
        }

        const renderPage = async (page: Awaited<ReturnType<typeof pdf.getPage>>) => {
          const cssViewport = page.getViewport({ scale: baseScale });
          const qualityBoost = Math.min(2.4, (window.devicePixelRatio || 1) * 1.25);
          const renderViewport = page.getViewport({ scale: baseScale * qualityBoost });
          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'pdf-page';
          pageWrapper.style.width = `${cssViewport.width}px`;
          pageWrapper.style.height = `${cssViewport.height}px`;
          pageWrapper.dataset.pageNumber = String(page.pageNumber);
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = renderViewport.width;
          canvas.height = renderViewport.height;
          canvas.style.width = `${cssViewport.width}px`;
          canvas.style.height = `${cssViewport.height}px`;
          pageWrapper.appendChild(canvas);
          const textLayer = document.createElement('div');
          textLayer.className = 'textLayer';
          textLayer.style.width = `${cssViewport.width}px`;
          textLayer.style.height = `${cssViewport.height}px`;
          pageWrapper.appendChild(textLayer);
          if (ctx) await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
          const textContent = await page.getTextContent();
          renderTextLayer({ textContentSource: textContent, container: textLayer, viewport: cssViewport });
          return pageWrapper;
        };

        const wrappers: HTMLElement[] = [];
        if (firstPage) {
          if (cancelled) return;
          wrappers.push(await renderPage(firstPage));
        }
        for (let pageNum = firstPage ? 2 : 1; pageNum <= pdf.numPages; pageNum += 1) {
          if (cancelled) return;
          wrappers.push(await renderPage(await pdf.getPage(pageNum)));
        }
        if (spread) {
          for (let idx = 0; idx < wrappers.length; idx += 2) {
            const row = document.createElement('div');
            row.className = 'pdf-spread';
            row.appendChild(wrappers[idx]);
            if (wrappers[idx + 1]) row.appendChild(wrappers[idx + 1]);
            container.appendChild(row);
          }
        } else wrappers.forEach((wrapper) => container.appendChild(wrapper));

        if (onOutline) {
          try {
            const outline = await pdf.getOutline();
            const items: { title: string; page?: number; level: number }[] = [];
            const walk = async (entries: any[], level: number) => {
              if (!entries) return;
              for (const entry of entries) {
                let pageNumber: number | undefined;
                try {
                  const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest;
                  if (Array.isArray(dest) && dest.length > 0) pageNumber = (await pdf.getPageIndex(dest[0])) + 1;
                } catch { pageNumber = undefined; }
                items.push({ title: entry.title || t('(untitled)'), page: pageNumber, level });
                if (entry.items?.length) await walk(entry.items, level + 1);
              }
            };
            await walk(outline || [], 1);
            onOutline(items);
          } catch { onOutline([]); }
        }
      } catch (err) {
        console.error('PDF render error:', err);
        container.innerHTML = `<div class="muted">${t('PDF 渲染失败')}</div>`;
      }
    };
    render().catch(() => { container.innerHTML = `<div class="muted">${t('PDF 渲染失败')}</div>`; });
    return () => { cancelled = true; container.innerHTML = ''; };
  }, [containerRef, fitWidth, onFitScale, onOutline, pdfUrl, scale, spread, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll('.pdf-annotation').forEach((node) => node.remove());
    annotations.forEach((note) => {
      const pageEl = container.querySelector(`.pdf-page[data-page-number="${note.page}"]`) as HTMLElement | null;
      if (!pageEl) return;
      const marker = document.createElement('div');
      marker.className = 'pdf-annotation';
      marker.style.left = `${note.x * 100}%`;
      marker.style.top = `${note.y * 100}%`;
      marker.title = note.text;
      marker.dataset.annotationId = note.id;
      pageEl.appendChild(marker);
    });
  }, [annotations, containerRef, pdfUrl, spread]);

  return <div className={`pdf-preview ${annotateMode ? 'annotate' : ''}`} ref={containerRef} onClick={(event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (annotateMode && onAddAnnotation) {
      const pageEl = target.closest('.pdf-page') as HTMLElement | null;
      if (pageEl) {
        const rect = pageEl.getBoundingClientRect();
        onAddAnnotation(Number(pageEl.dataset.pageNumber || 1), (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
        return;
      }
    }
    if (target.tagName === 'SPAN') {
      const text = (target.textContent || '').trim();
      if (text.length >= 3) onTextClick(text);
    }
  }} />;
}
