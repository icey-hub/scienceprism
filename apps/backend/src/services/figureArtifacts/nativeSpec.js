// Pure fixed-tool contract: the isolated worker imports no project service.
export const NATIVE_FONT = 'Arial Unicode MS';
export const NATIVE_VERSION = '1.0.0';
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => plain(x) && Object.keys(x).every(k => keys.includes(k));
const fail = message => { throw Object.assign(new Error(message), { code: 'FIGURE_NATIVE_INPUT_INVALID', statusCode: 400 }); };
export function wrapNativeText(text, width) {
  const n = Math.max(1, Math.floor((width - 16) / 13));
  return text.split('\n').flatMap(line => { const chars = [...line]; return chars.length ? Array.from({ length: Math.ceil(chars.length / n) }, (_, i) => chars.slice(i * n, (i + 1) * n).join('')) : ['']; });
}
export function validateNativeSpec(spec, style = {}) {
  if (!exact(spec, ['schemaVersion', 'canvas', 'nodes', 'edges', 'references']) || spec.schemaVersion !== 1
    || !exact(spec.canvas, ['widthPt', 'heightPt']) || spec.canvas.widthPt !== 720 || spec.canvas.heightPt !== 540
    || !Array.isArray(spec.nodes) || spec.nodes.length < 1 || spec.nodes.length > 30 || !Array.isArray(spec.edges) || spec.edges.length > 60
    || spec.references !== undefined && (!Array.isArray(spec.references) || spec.references.length)) fail('仅接受720×540pt原生示意图、1–30节点、最多60边；本片不接受未绑定文献。');
  if (!exact(style, ['title', 'xLabel', 'yLabel', 'palette']) || style.xLabel && style.xLabel !== '' || style.yLabel && style.yLabel !== '') fail('原生示意图只接受标题和固定配色，不接受轴标签。');
  const titleHeight = style.title ? Math.max(40, 16 + 18 * wrapNativeText(style.title, 720).length) : 0;
  const ids = new Set(), identifier = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !ids.has(id);
  for (const node of spec.nodes) {
    if (!exact(node, ['id', 'type', 'x', 'y', 'width', 'height', 'text']) || !identifier(node.id) || !['text', 'rect', 'ellipse'].includes(node.type)
      || !['x', 'y', 'width', 'height'].every(k => typeof node[k] === 'number' && Number.isFinite(node[k]))
      || node.x < 0 || node.y < titleHeight || node.width < 1 || node.height < 1 || node.x + node.width > 720 || node.y + node.height > 540
      || typeof node.text !== 'string' || [...node.text].length > 240 || !node.text.isWellFormed() || /[\x00-\x09\x0b-\x1f\x7f]/.test(node.text)
      || node.text && node.height < 16 + 18 * wrapNativeText(node.text, node.width).length) fail('节点ID、边界或文字尺寸无效；文字需完整容纳，不会截断。');
    ids.add(node.id);
  }
  const nodeIds = new Set(ids);
  for (const edge of spec.edges) {
    if (!exact(edge, ['id', 'from', 'to']) || !identifier(edge.id) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) fail('边需唯一ID及两个不同的真实节点端点。');
    ids.add(edge.id);
  }
  return structuredClone(spec);
}
export function nativeBoundary(node, other) {
  const cx = node.x + node.width / 2, cy = node.y + node.height / 2;
  const dx = other.x + other.width / 2 - cx, dy = other.y + other.height / 2 - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = node.type === 'ellipse' ? 1 / Math.sqrt((dx / (node.width / 2)) ** 2 + (dy / (node.height / 2)) ** 2) : Math.min(dx ? node.width / 2 / Math.abs(dx) : Infinity, dy ? node.height / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * scale, y: cy + dy * scale };
}
export function nativeObjects(spec, style) {
  const objects = [];
  if (style.title) objects.push({ id: 'figure-title', type: 'text', x: 0, y: 0, width: 720, height: 16 + 18 * wrapNativeText(style.title, 720).length, text: wrapNativeText(style.title, 720).join('\n') });
  for (const n of spec.nodes) {
    if (n.type !== 'text') objects.push({ ...n, id: `shape-${n.id}`, text: '', type: n.type });
    if (n.type === 'text' || n.text) objects.push({ ...n, id: `text-${n.id}`, type: 'text', text: wrapNativeText(n.text, n.width).join('\n') });
  }
  for (const e of spec.edges) {
    const a = spec.nodes.find(n => n.id === e.from), b = spec.nodes.find(n => n.id === e.to);
    const start = nativeBoundary(a, b), end = nativeBoundary(b, a);
    const x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;
    objects.push({ id: `edge-${e.id}`, type: 'line', x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), x1, y1, x2, y2 });
  }
  return objects;
}
export const NATIVE_TOOL_SCHEMA = { type: 'object', additionalProperties: false, required: ['spec', 'style', 'sourceSha256'], properties: { spec: { type: 'object' }, style: { type: 'object' }, sourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } };
