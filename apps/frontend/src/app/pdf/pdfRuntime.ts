import { getDocument, GlobalWorkerOptions, TextLayer, version, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getCollabToken } from '../../api/client';
import 'pdfjs-dist/web/pdf_viewer.css';

GlobalWorkerOptions.workerSrc = workerUrl;

export function loadPdf(url: string) {
  const token = getCollabToken();
  const assets = `/pdfjs/${version}/`;
  return getDocument({ url,
    httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
    cMapUrl: `${assets}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`
  });
}

/** One cancellable canvas/text-layer render, shared by reading and writing. */
export function renderPdfPage(page: PDFPageProxy, wrapper: HTMLElement, scale: number, rotation = 0) {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  const quality = Math.min(2, window.devicePixelRatio || 1);
  wrapper.style.width = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;
  wrapper.style.setProperty('--scale-factor', String(scale));
  wrapper.style.setProperty('--total-scale-factor', String(scale * page.userUnit));
  wrapper.dataset.pageNumber = String(page.pageNumber);
  wrapper.dataset.rotation = String((page.rotate + rotation) % 360);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width * quality);
  canvas.height = Math.ceil(viewport.height * quality);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const textElement = document.createElement('div');
  textElement.className = 'textLayer';
  wrapper.append(canvas, textElement);
  const canvasTask = page.render({ canvas, viewport, transform: quality === 1 ? undefined : [quality, 0, 0, quality, 0, 0] });
  let textLayer: TextLayer | undefined;
  let cancelled = false;
  const promise = (async () => {
    const content = await page.getTextContent();
    if (cancelled) return false;
    textLayer = new TextLayer({ textContentSource: content, container: textElement, viewport });
    await Promise.all([canvasTask.promise, textLayer.render()]);
    return content.items.some(item => 'str' in item && item.str.trim());
  })();
  // Both promises are observed even if text extraction fails first.
  void canvasTask.promise.catch(() => {});
  return { promise, cancel() { cancelled = true; canvasTask.cancel(); textLayer?.cancel(); canvas.remove(); textElement.remove(); canvas.width = canvas.height = 0; } };
}
