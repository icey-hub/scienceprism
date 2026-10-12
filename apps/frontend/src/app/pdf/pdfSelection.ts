import type { ReadingSelection } from '../../api/paperReaderAdapter';

export function capturePdfSelection(root: HTMLElement, attachmentId: string, fileSha256: string): { selection?: ReadingSelection; message?: string } {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return {};
  const range = selection.getRangeAt(0);
  const parent = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.reader-pdf-page');
  const start = parent(range.startContainer), end = parent(range.endContainer);
  if (!start || !root.contains(start)) return {};
  if (start !== end) return { message: '请在同一页内选择文字，跨页内容可分别保存为批注。' };
  const text = selection.toString().trim();
  if (!text) return {};
  const bounds = start.getBoundingClientRect();
  const rotation = Number(start.dataset.rotation || 0);
  const unrotate = (x: number, y: number) => rotation === 90 ? [y, 1 - x] : rotation === 180 ? [1 - x, 1 - y] : rotation === 270 ? [1 - y, x] : [x, y];
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => {
    const a = unrotate(clamp((rect.left - bounds.left) / bounds.width), clamp((rect.top - bounds.top) / bounds.height));
    const b = unrotate(clamp((rect.right - bounds.left) / bounds.width), clamp((rect.bottom - bounds.top) / bounds.height));
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
  }).filter(rect => rect.width > 0 && rect.height > 0);
  if (rects.length > 128) return { message: '这次选区过长，请分成较短段落保存。' };
  return { selection: { id: crypto.randomUUID(), text, page: Number(start.dataset.pageNumber), attachmentId, fileSha256, rects } };
}
