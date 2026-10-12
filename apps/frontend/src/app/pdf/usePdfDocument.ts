import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdf } from './pdfRuntime';
export interface PdfOutline { title: string; page?: number; level: number }
export function usePdfDocument(url: string) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [outline, setOutline] = useState<PdfOutline[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setPdf(null); setError(''); setOutline([]);
    const task = loadPdf(url);
    void task.promise.then(async document => {
      if (disposed) return;
      setPdf(document);
      const items: PdfOutline[] = [];
      const visit = async (entries: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>, level: number) => {
        for (const entry of entries || []) {
          if (disposed) return;
          let page: number | undefined;
          try { const dest = typeof entry.dest === 'string' ? await document.getDestination(entry.dest) : entry.dest; if (Array.isArray(dest)) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await document.getPageIndex(dest[0])) + 1; } catch { /* Broken outline destinations remain labelled. */ }
          items.push({ title: entry.title || '未命名章节', page, level });
          await visit(entry.items, level + 1);
        }
      };
      try { await visit(await document.getOutline(), 0); if (!disposed) setOutline(items); } catch { /* Reading remains available without a valid outline. */ }
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'PDF 无法打开'); });
    return () => { disposed = true; void task.destroy(); };
  }, [url]);
  return { pdf, outline, error };
}
