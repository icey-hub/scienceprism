import PptxGenJS from 'pptxgenjs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { NATIVE_FONT, NATIVE_VERSION, NATIVE_TOOL_SCHEMA, validateNativeSpec, nativeObjects } from './nativeSpec.js';
const xml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export async function renderNativeDiagram({ spec, style, sourceSha256, ...extra }) {
  if (Object.keys(extra).length || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Invalid fixed render request.');
  validateNativeSpec(spec, style);
  const color = { 'blue-orange': ['DCEAF7', '286498'], 'purple-green': ['E8DFF1', '74509B'], grayscale: ['EEEEEE', '555555'] }[style.palette || 'blue-orange'];
  if (!color || typeof style.title !== 'string' || style.title.length > 120 || /[\x00-\x1f\x7f]/.test(style.title)) throw new Error('Invalid fixed style.');
  const pptx = new PptxGenJS(); pptx.defineLayout({ name: 'FIGURE', width: 10, height: 7.5 }); pptx.layout = 'FIGURE';
  pptx.author = 'SciencePrism'; pptx.subject = 'User-authored method diagram; not experimental evidence'; pptx.title = style.title || 'Method diagram';
  const slide = pptx.addSlide(), svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="720" height="540" viewBox="0 0 720 540">', '<rect width="720" height="540" fill="white"/>', `<defs><marker id="native-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#${color[1]}"/></marker></defs>`];
  const objects = nativeObjects(spec, style);
  // Native editable lines are deliberately not claimed as attached connectors.
  for (const o of [...objects.filter(o => o.type === 'line'), ...objects.filter(o => !['line', 'text'].includes(o.type))]) {
    const pos = { x: o.x / 72, y: o.y / 72, w: o.width / 72, h: o.height / 72, objectName: o.id };
    slide.addShape(o.type, { ...pos, ...(o.type === 'line' ? { flipH: o.x2 < o.x1, flipV: o.y2 < o.y1 } : { fill: { color: color[0] } }), line: { color: color[1], width: o.type === 'line' ? 2 : 1.5, ...(o.type === 'line' ? { endArrowType: 'triangle' } : {}) } });
    if (o.type === 'line') svg.push(`<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" stroke="#${color[1]}" stroke-width="2" marker-end="url(#native-arrow)"/>`);
    else if (o.type === 'rect') svg.push(`<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="#${color[0]}" stroke="#${color[1]}"/>`);
    else svg.push(`<ellipse cx="${o.x + o.width / 2}" cy="${o.y + o.height / 2}" rx="${o.width / 2}" ry="${o.height / 2}" fill="#${color[0]}" stroke="#${color[1]}"/>`);
  }
  for (const o of objects.filter(o => o.type === 'text')) {
    slide.addText(o.text, { x: o.x / 72, y: o.y / 72, w: o.width / 72, h: o.height / 72, objectName: o.id, fontFace: NATIVE_FONT, fontSize: 14, margin: 8, valign: 'mid', align: 'center', color: '26373D', breakLine: false, paraSpaceAfterPt: 0, lineSpacingMultiple: undefined, lineSpacing: 18 });
    const lines = o.text.split('\n'), centerX = o.x + o.width / 2, firstY = o.y + o.height / 2 - (lines.length - 1) * 9;
    svg.push(`<text font-family="${NATIVE_FONT}" text-anchor="middle" dominant-baseline="middle" font-size="14" fill="#26373d">${lines.map((line, i) => `<tspan x="${centerX}" y="${firstY + i * 18}">${xml(line)}</tspan>`).join('')}</text>`);
  }
  svg.push('</svg>');
  return { version: NATIVE_VERSION, backend: 'pptxgenjs-4.0.1', sourceSha256, requestSha256: createHash('sha256').update(JSON.stringify({ spec, style })).digest('hex'), pptx: Buffer.from(await pptx.write({ outputType: 'nodebuffer' })).toString('base64'), svg: Buffer.from(svg.join('\n')).toString('base64') };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = new Server({ name: 'scienceprism-native-figures', version: NATIVE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'render_native_figure', description: 'Fixed app-owned editable diagram export. No file paths or user code.', inputSchema: NATIVE_TOOL_SCHEMA, annotations: { readOnlyHint: false } }] }));
  server.setRequestHandler('tools/call', async request => {
    if (request.params.name !== 'render_native_figure') throw new Error('Unknown fixed tool.');
    return { content: [{ type: 'text', text: JSON.stringify(await renderNativeDiagram(request.params.arguments)) }] };
  });
  await server.connect(new StdioServerTransport());
}
