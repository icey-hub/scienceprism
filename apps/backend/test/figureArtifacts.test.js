import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/figure-owner-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true }); const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data; process.env.SCIENCEPRISM_FIGURE_PYTHON = process.execPath;
const owner = await import('../src/services/figureArtifacts/index.js');
const { parseLatexFigureTable } = await import('../src/services/figureArtifacts/tableSource.js');
const { registerFigureRoutes } = await import('../src/routes/figures.js');
const { registerPlotRoutes } = await import('../src/routes/plot.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
after(async () => { await fs.rm(data, { recursive: true, force: true }); });
const tableLatex = String.raw`\begin{tabular}{lrr}
\toprule
\textbf{组别} & 分数 & 损失 \\
\midrule
基线 & $-0.25$ & 1.0 \\
候选 & 0.15 & 3e-2 \\
\bottomrule
\end{tabular}`;
async function fixture(id) {
  const root = path.join(data, id); await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await fs.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));
  await fs.writeFile(path.join(root, 'study.tex'), `Original source\n${tableLatex}\n`);
  return { id, root, input: { tableLatex, sourcePath: 'study.tex', chartType: 'bar', layout: 'panels' } };
}
function rendererReceipt(counter) {
  return async (manifest, options) => {
    // Controlled renderer receipt fixture only; the root verifies real Matplotlib/UI separately.
    counter.count++;
    const source = JSON.parse(await fs.readFile(path.join(options.workspaceRoot, 'source.json'), 'utf8'));
    assert.equal(source.kind, 'table'); assert.deepEqual(source.parsedTable.series[0].values, [-0.25, 0.15]);
    assert.equal(manifest.command.entrypoint, 'renderer.py');
    await fs.writeFile(path.join(options.workspaceRoot, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 1"/><text>Fixture receipt</text></svg>');
    await fs.writeFile(path.join(options.workspaceRoot, 'figure.pdf'), '%PDF-fixture'); await fs.writeFile(path.join(options.workspaceRoot, 'figure.png'), 'PNG-fixture');
    await fs.writeFile(path.join(options.workspaceRoot, 'runtime.json'), JSON.stringify({ pythonVersion: 'fixture', matplotlibVersion: 'fixture', font: { family: 'fixture' } }));
    options.onProcess({ pid: 12345, stopConfirmed: true }); return { exitCode: 0, isolation: 'controlled-receipt-fixture' };
  };
}

test('finite LaTeX parser preserves every row/negative value and rejects ambiguous merged, uncertainty and missing-column data', () => {
  const parsed = parseLatexFigureTable(tableLatex);
  assert.deepEqual(parsed.headers, ['组别', '分数', '损失']); assert.deepEqual(parsed.rowLabels, ['基线', '候选']); assert.deepEqual(parsed.series.map(series => series.values), [[-0.25, 0.15], [1, 0.03]]);
  for (const invalid of [tableLatex.replace('0.15', '0.15 ± 0.02'), tableLatex.replace('0.15', '1e500'), tableLatex.replace('候选', String.raw`\multirow{2}{*}{候选}`), tableLatex.replace('0.15 & 3e-2', '0.15')]) assert.throws(() => parseLatexFigureTable(invalid), { code: 'FIGURE_TABLE_INVALID' });
  assert.throws(() => owner.validateTableFigureInput({ tableLatex, chartType: 'heatmap', layout: 'panels' }), { code: 'FIGURE_TABLE_INPUT_INVALID' });
});

test('one owner publishes table versions, preserves pasted/file source, style-only revisions and compatibility routes without models', async () => {
  const f = await fixture('table-owner'), counter = { count: 0 }, render = rendererReceipt(counter), app = Fastify();
  registerFigureRoutes(app, { render }); registerPlotRoutes(app, { render });
  const response = await app.inject({ method: 'POST', url: `/api/projects/${f.id}/figures/from-table`, headers: { 'x-scienceprism-actor': 'human' }, payload: f.input });
  assert.equal(response.statusCode, 200); const first = response.json().figure; assert.equal(first.kind, 'table'); assert.equal(first.statistics.sampleSize, null); assert.equal(first.statistics.dataRows, 2); assert.equal(first.statistics.series, 2);
  assert.equal((await owner.createTableFigure(f.id, f.input, { render })).id, first.id); assert.equal(counter.count, 1);
  const source = (await app.inject({ method: 'GET', url: `/api/projects/${f.id}/figures/${first.id}/source` })).json().source;
  assert.equal(source.tableLatex, tableLatex); assert.equal(source.sourceOrigin, 'project-file'); assert.ok(source.sourceFileSha256); assert.equal(source.sampleSize, null);
  await fs.writeFile(path.join(f.root, 'study.tex'), 'Changed source after the original frozen figure');
  const revisionResponse = await app.inject({ method: 'POST', url: `/api/projects/${f.id}/figures/${first.id}/revisions`, headers: { 'x-scienceprism-actor': 'human' }, payload: { style: { title: '独立样式版本', palette: 'grayscale' } } });
  assert.equal(revisionResponse.statusCode, 200); const revised = revisionResponse.json().figure; assert.equal(revised.parentFigureId, first.id); assert.equal(revised.sourceSha256, first.sourceSha256); assert.notEqual(revised.id, first.id);
  await assert.rejects(owner.prepareTableFigureSource(f.id, f.input), { code: 'FIGURE_TABLE_SOURCE_MISMATCH' });
  const legacy = await app.inject({ method: 'POST', url: '/api/plot/from-table', payload: { projectId: f.id, tableLatex, chartType: 'line', filename: '../../not-a-path.png', llmConfig: { token: 'fixture-not-used' }, retries: 2 } });
  assert.equal(legacy.statusCode, 200); assert.ok(legacy.json().assetPath.startsWith('assets/plots/table-figure-')); assert.deepEqual(legacy.json().deprecation.ignoredFields, ['llmConfig', 'retries']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plot/from-table', payload: { projectId: f.id, tableLatex, prompt: 'Write arbitrary Python' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${f.id}/figures/${first.id}/revisions`, headers: { 'x-scienceprism-actor': 'human' }, payload: { style: {}, tableLatex } })).statusCode, 400);
  const figures = (await app.inject({ method: 'GET', url: `/api/projects/${f.id}/figures` })).json().figures; assert.equal(figures.length, 3);
  assert.ok(figures.every(figure => figure.files.png.url.includes('/blob?path='))); await app.close();
});

test('existing campaign source/renderer hashes and ID remain readable through the unified owner without rewriting old metadata', async () => {
  const f = await fixture('campaign-compat'), source = { schemaVersion: 1, projectId: f.id, campaignId: 'original-campaign', rows: [{ seed: '0', delta: -0.1 }] };
  const style = { title: 'Original figure', xLabel: '', yLabel: 'score', palette: 'blue-orange' }, rendererSource = await fs.readFile(fileURLToPath(new URL('../src/services/figureArtifacts/paired_renderer.py', import.meta.url)));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex'), rendererSha = sha(rendererSource), sourceSha = sourceHash(source), styleSha = sourceHash(style);
  const id = `campaign-figure-${sourceHash({ source: sourceSha, style: styleSha, renderer: rendererSha })}`, directory = path.join(f.root, 'assets/plots', id);
  await fs.mkdir(directory, { recursive: true }); const files = {};
  for (const [kind, name, content] of [['svg', 'figure.svg', '<svg/>'], ['pdf', 'figure.pdf', '%PDF-original'], ['png', 'figure.png', 'PNG-original'], ['source', 'source.json', JSON.stringify(source)], ['rendererSource', 'renderer.py', rendererSource]]) {
    const bytes = Buffer.from(content); await fs.writeFile(path.join(directory, name), bytes); files[kind] = { path: `assets/plots/${id}/${name}`, sha256: sha(bytes), bytes: bytes.length };
  }
  const metadata = JSON.stringify({ id, projectId: f.id, campaignId: source.campaignId, createdAt: '2026-10-14T00:00:00Z', sourceSha256: sourceSha, styleSha256: styleSha, style, renderer: { sha256: rendererSha }, statistics: { n: 1 }, files });
  await fs.writeFile(path.join(directory, 'metadata.json'), metadata);
  const figure = await owner.getFigureArtifact(f.id, id); assert.equal(figure.kind, 'campaign'); assert.equal(figure.id, id); assert.deepEqual(await owner.getFigureSource(f.id, id), source);
  assert.equal((await owner.listProjectFigures(f.id)).length, 1); assert.equal(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'), metadata);
});
