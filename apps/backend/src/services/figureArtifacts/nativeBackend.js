import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import unzipper from 'unzipper';
import { XMLParser } from 'fast-xml-parser';
import { withMcpClient } from '../mcp/index.js';
import { NATIVE_FONT, NATIVE_VERSION, NATIVE_TOOL_SCHEMA, nativeObjects } from './nativeSpec.js';
const worker = fileURLToPath(new URL('./native_worker.mjs', import.meta.url));
const fail = message => { throw Object.assign(new Error(message), { code: 'FIGURE_NATIVE_OUTPUT_INVALID', statusCode: 422 }); };
const hash = x => createHash('sha256').update(x).digest('hex');
export async function readNativeRendererSource() {
  const schema = await fs.readFile(new URL('./nativeSpec.js', import.meta.url), 'utf8');
  const fixedWorker = await fs.readFile(worker, 'utf8');
  return Buffer.from(fixedWorker.replace(/^import .* from '\.\/nativeSpec\.js';$/m, schema));
}
export async function renderNativeWithMcp(projectId, request, { signal, beforeRequest } = {}) {
  let processState;
  const payload = await withMcpClient(projectId, { transport: 'stdio', command: process.execPath, args: [worker], env: {} }, async (client, requestSignal) => {
    const tools = await client.listTools(undefined, { timeout: 8000, signal: requestSignal });
    if (tools.tools.length !== 1 || tools.tools[0].name !== 'render_native_figure' || !isDeepStrictEqual(tools.tools[0].inputSchema, NATIVE_TOOL_SCHEMA)) fail('固定MCP工具声明变化。');
    const result = await client.callTool({ name: 'render_native_figure', arguments: request }, { timeout: 8000, signal: requestSignal });
    if (result.isError || result.content?.length !== 1 || result.content[0].type !== 'text' || result.content[0].text.length > 950000) fail('固定MCP输出无效。');
    return JSON.parse(result.content[0].text);
  }, { signal, beforeRequest, copyProject: false, onProcess: state => { processState = state; } });
  if (!processState?.stopConfirmed || !Number.isInteger(processState.pid) || processState.pid < 1) fail('MCP进程尚未确认停止。');
  return { payload, process: processState, isolation: processState.isolation };
}
const array = x => x === undefined ? [] : Array.isArray(x) ? x : [x];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false });
const parse = bytes => { const text = bytes.toString('utf8'); if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('OOXML不能含实体声明。'); return parser.parse(text); };
export async function validateNativeOutput(payload, { spec, style, sourceSha256 }) {
  if (payload.version !== NATIVE_VERSION || payload.backend !== 'pptxgenjs-4.0.1' || payload.sourceSha256 !== sourceSha256 || payload.requestSha256 !== hash(JSON.stringify({ spec, style }))) fail('MCP输出不属于固定输入。');
  const decode = value => { if (typeof value !== 'string' || value.length > 900000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('产物base64无效。'); const bytes = Buffer.from(value, 'base64'); if (!bytes.length) fail('产物为空。'); return bytes; };
  const pptx = decode(payload.pptx), svg = decode(payload.svg), zip = await unzipper.Open.buffer(pptx);
  if (zip.files.length > 100 || zip.files.some(e => e.uncompressedSize > 1000000 || /(^\/|\.\.|\\)/.test(e.path)) || zip.files.reduce((n, e) => n + e.uncompressedSize, 0) > 4000000 || zip.files.some(e => e.type !== 'Directory' && /^(?:ppt\/media\/|ppt\/embeddings\/|ppt\/charts\/)/.test(e.path))) fail('PPTX文件集不符合原生图形限制。');
  const slides = zip.files.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.path));
  if (slides.length !== 1) fail('原生图形须为单页。');
  for (const e of zip.files.filter(e => e.path.endsWith('.rels'))) if (/TargetMode="External"/i.test((await e.buffer()).toString())) fail('PPTX不接受外部关联。');
  const presentation = parse(await zip.files.find(e => e.path === 'ppt/presentation.xml').buffer())['p:presentation'];
  if (Number(presentation['p:sldSz'].cx) !== 720 * 12700 || Number(presentation['p:sldSz'].cy) !== 540 * 12700) fail('PPTX画布尺寸变化。');
  const slide = parse(await slides[0].buffer()), tree = slide['p:sld']['p:cSld']['p:spTree'];
  if (array(tree['p:pic']).length || array(tree['p:cxnSp']).length || array(tree['p:graphicFrame']).length) fail('仅接受真实原生形状/文字/线，不接受图片或外部内容。');
  const shapes = array(tree['p:sp']), expected = nativeObjects(spec, style), fonts = new Set();
  if (shapes.length !== expected.length) fail('原生对象数量不匹配。');
  for (const o of expected) {
    const matches = shapes.filter(s => s['p:nvSpPr']?.['p:cNvPr']?.name === o.id);
    if (matches.length !== 1) fail('原生对象ID缺失或重复。');
    const s = matches[0], transform = s['p:spPr']['a:xfrm'];
    const geometry = [transform['a:off'].x, transform['a:off'].y, transform['a:ext'].cx, transform['a:ext'].cy].map(Number);
    if (geometry.some((v, i) => Math.abs(v - [o.x, o.y, o.width, o.height][i] * 12700) > 2)) fail('原生对象边界不符合固定结构。');
    if (s['p:spPr']['a:prstGeom']?.prst !== (o.type === 'text' ? 'rect' : o.type)) fail('原生对象图形类型变化。');
    if (o.type === 'line') {
      const flipped = value => value === '1' || value === 'true' || value === true;
      if (flipped(transform.flipH) !== (o.x2 < o.x1) || flipped(transform.flipV) !== (o.y2 < o.y1) || s['p:spPr']['a:ln']?.['a:tailEnd']?.type !== 'triangle') fail('原生连线方向或箭头变化。');
    }
    if (o.type === 'text') {
      if (s['p:txBody']?.['a:bodyPr']?.anchor !== 'ctr') fail('原生文字应垂直居中。');
      const paragraphs = array(s['p:txBody']?.['a:p']);
      const text = paragraphs.map(p => { if (p['a:pPr']?.algn !== 'ctr' || Number(p['a:pPr']?.['a:lnSpc']?.['a:spcPts']?.val) !== 1800) fail('原生文字应居中并使用固定18pt行距。'); return array(p['a:r']).map(r => { const face = r['a:rPr']?.['a:latin']?.typeface; if (face) fonts.add(face); if (Number(r['a:rPr']?.sz) !== 1400 || face !== NATIVE_FONT) fail('原生字体或字号变化。'); return r['a:t'] ?? ''; }).join(''); }).join('\n');
      if (text !== o.text) fail('原生文字被截断或改写。');
    }
  }
  const svgText = svg.toString('utf8');
  if (!svgText.includes('viewBox="0 0 720 540"') || /<image\b|<script\b|<foreignObject\b|(?:href|src)\s*=|<!ENTITY|<!DOCTYPE/i.test(svgText)) fail('SVG须为无外部资源的原生矢量。');
  return { pptx, svg, validation: { nativeObjects: shapes.length, nativeLines: spec.edges.length, nativeConnectors: 0, pictures: 0, boundsChecked: true, fonts: [...fonts], fontsEmbedded: false } };
}
