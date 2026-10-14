import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/native-figure-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'projects-')); process.env.SCIENCEPRISM_DATA_DIR = data;
const owner = await import('../src/services/figureArtifacts/index.js');
const { registerFigureRoutes } = await import('../src/routes/figures.js');
const { validateNativeSpec, wrapNativeText, nativeBoundary } = await import('../src/services/figureArtifacts/nativeSpec.js');
const { validateNativeOutput } = await import('../src/services/figureArtifacts/nativeBackend.js');
after(async () => fs.rm(data, { recursive: true, force: true }));
const spec = { schemaVersion: 1, canvas: { widthPt: 720, heightPt: 540 }, nodes: [
  { id: 'input', type: 'rect', x: 30, y: 80, width: 200, height: 90, text: '真实输入\n方法示意' },
  { id: 'method', type: 'ellipse', x: 380, y: 230, width: 220, height: 90, text: '对照算法' },
  { id: 'note', type: 'text', x: 30, y: 400, width: 350, height: 70, text: '用户示意，不冒充实测结果' }
], edges: [{ id: 'flow', from: 'input', to: 'method' }] };
async function fixture(id) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));
  return root;
}
test('native MCP export: real editable OOXML, vector, stopped process, immutable owner revisions and HTTP boundary', async () => {
  const root = await fixture('native-project');
  const app = Fastify(); registerFigureRoutes(app);
  const response = await app.inject({ method: 'POST', url: '/api/projects/native-project/figures/native', headers: { 'x-scienceprism-actor': 'human' }, payload: { spec, style: { title: '原生方法图', palette: 'blue-orange' } } });
  assert.equal(response.statusCode, 200, response.body);
  const first = response.json().figure;
  assert.equal(first.kind, 'diagram'); assert.equal(first.familyId, first.id);
  assert.equal(first.validation.pictures, 0); assert.equal(first.validation.nativeLines, 1); assert.equal(first.validation.nativeConnectors, 0);
  assert.deepEqual(first.validation.fonts, ['Arial Unicode MS']); assert.equal(first.renderer.process.stopConfirmed, true);
  assert.throws(() => process.kill(first.renderer.process.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(Object.keys(first.files).sort(), ['pptx', 'rendererSource', 'source', 'svg']);
  const source = await owner.getFigureSource('native-project', first.id); assert.deepEqual(source.spec, spec); assert.match(source.caption, /不是实验结果/);
  assert.equal((await owner.createNativeFigure('native-project', { spec, style: first.style })).id, first.id);
  const second = await owner.reviseFigureArtifact('native-project', first.id, { style: { title: '改版原生图', palette: 'grayscale' } });
  assert.notEqual(second.id, first.id); assert.equal(second.parentFigureId, first.id); assert.equal(second.familyId, first.id); assert.equal(second.sourceSha256, first.sourceSha256);
  assert.equal((await owner.listProjectFigures('native-project')).length, 2);
  const independent = await owner.createNativeFigure('native-project', { spec, style: { title: '独立框图' } });
  const sameContent = await owner.createNativeFigure('native-project', { spec, style: first.style, parentFigureId: independent.id });
  assert.notEqual(sameContent.id, first.id); assert.equal(sameContent.familyId, independent.id); assert.equal(sameContent.parentFigureId, independent.id);
  assert.equal((await owner.createNativeFigure('native-project', { spec, style: first.style, parentFigureId: independent.id })).id, sameContent.id);
  assert.equal((await owner.getFigureArtifact('native-project', first.id)).familyId, first.id);
  const svg = await fs.readFile(path.join(root, first.files.svg.path), 'utf8'); assert.match(svg, /真实输入/); assert.doesNotMatch(svg, /<image|<script/); assert.match(svg, /marker-end="url\(#native-arrow\)"/); assert.match(svg, /text-anchor="middle"/);
  const rendererSource = await fs.readFile(path.join(root, first.files.rendererSource.path), 'utf8'); assert.doesNotMatch(rendererSource, /from '\.\/nativeSpec\.js'/); assert.match(rendererSource, /export function nativeBoundary/);
  const payload = { version: '1.0.0', backend: 'pptxgenjs-4.0.1', sourceSha256: first.sourceSha256, requestSha256: 'wrong' };
  await assert.rejects(validateNativeOutput(payload, { spec, style: first.style, sourceSha256: first.sourceSha256 }), { code: 'FIGURE_NATIVE_OUTPUT_INVALID' });
  await fixture('other-project'); await assert.rejects(owner.createNativeFigure('other-project', { spec, parentFigureId: first.id }), { code: 'ENOENT' });
  const rejected = await app.inject({ method: 'POST', url: '/api/projects/native-project/figures/native', payload: { spec } }); assert.equal(rejected.statusCode, 403);
  await app.close();
});
test('fixed structure rejects fake references, paths, overflow and absent endpoints; wrapping retains every codepoint', () => {
  const changed = patch => ({ ...structuredClone(spec), ...patch });
  assert.throws(() => validateNativeSpec(changed({ references: [{ doi: 'made-up' }] })), { code: 'FIGURE_NATIVE_INPUT_INVALID' });
  assert.throws(() => validateNativeSpec(changed({ path: '/tmp/output.pptx' })), { code: 'FIGURE_NATIVE_INPUT_INVALID' });
  assert.throws(() => validateNativeSpec(changed({ edges: [{ id: 'bad', from: 'input', to: 'missing' }] })), { code: 'FIGURE_NATIVE_INPUT_INVALID' });
  const overflow = structuredClone(spec); overflow.nodes[0].height = 10; assert.throws(() => validateNativeSpec(overflow), { code: 'FIGURE_NATIVE_INPUT_INVALID' });
  assert.equal(wrapNativeText('中文😀abcdef', 50).join(''), '中文😀abcdef');
  const a = { x: 0, y: 0, width: 100, height: 100, type: 'rect' }, b = { x: 200, y: 0, width: 100, height: 100, type: 'ellipse' };
  assert.deepEqual(nativeBoundary(a, b), { x: 100, y: 50 }); assert.deepEqual(nativeBoundary(b, a), { x: 200, y: 50 });
});
