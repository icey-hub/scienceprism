import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/replication-paper-tests/', import.meta.url));
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'projects-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');
const { readReplicationContextFromWorkflow, assertReplicationPreparationUnchangedFromWorkflow } = await import('../src/services/experimentRunner/replicationContext.js');
const { buildExperimentManifest, manifestSummary } = await import('../src/services/experimentRunner/manifest.js');
const { createExperimentRun, experimentRunSummary } = await import('../src/services/experimentRunner/index.js');
const { sourceHash } = await import('../src/services/researchAutomation/handoff.js');
after(() => fs.rm(data, { recursive: true, force: true }));

const protocol = { datasetSplit: 'The two class subset and fixed sample ordering from protocol.json.',
  metricExtraction: 'Read mean_difference and pooled_scatter from results/metrics.json.', referenceLocation: 'Pages 180–182, equations and the two class example.' };
// Saved selected-paper metadata fixtures, not a real search or reproduction.
function workflow(id, { bound = true } = {}) {
  const value = createWorkflowDocument(id);
  const selected = value.stages.find(stage => stage.id === 'selection');
  selected.status = 'approved';
  selected.data = { selectedPaperIds: ['other-paper', 'fisher-1936'], selectedPapers: [
    { id: 'other-paper', title: 'Another selected source', year: 2000 },
    { id: 'fisher-1936', title: 'The Use of Multiple Measurements in Taxonomic Problems', authors: ['R. A. Fisher'], year: 1936,
      doi: '10.1111/j.1469-1809.1936.tb02137.x', url: 'https://doi.org/10.1111/j.1469-1809.1936.tb02137.x', source: 'crossref',
      sourceRecords: [{ source: 'crossref', externalId: '10.1111/j.1469-1809.1936.tb02137.x' }], evidenceId: 'paper-fisher', sha256: 'supplied-untrusted-hash' }
  ] };
  const replication = value.stages.find(stage => stage.id === 'replication');
  replication.status = 'approved';
  replication.data = { replication: { repository: 'project-workspace', environment: 'Node', dataset: 'iris-fixture', datasetVersion: 'snapshot-1',
    note: 'Fixed two class protocol, with original seed and evaluation.', expectedMetrics: 'mean_difference and pooled_scatter are recorded',
    codePaths: ['run.mjs'], ...(bound ? { paperId: 'fisher-1936', evaluationProtocol: structuredClone(protocol) } : {}) } };
  return value;
}
const context = value => readReplicationContextFromWorkflow(value.projectId, value, { expectedVersion: value.version });
const plan = value => value.stages.find(stage => stage.id === 'replication').data.replication;
const selection = value => value.stages.find(stage => stage.id === 'selection').data;
async function project(value) {
  const root = path.join(data, value.projectId);
  await fs.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id: value.projectId, name: value.projectId }));
  await fs.writeFile(path.join(root, 'run.mjs'), "console.log('This metadata fixture is not executed.');");
  await writeWorkflowFile(root, value);
  return root;
}

test('explicit replication paper freezes the chosen selected source and exposes the original evaluation, seed and failure details', async () => {
  const value = workflow('explicit-paper'), root = await project(value), saved = context(value);
  assert.equal(saved.paper.id, 'fisher-1936'); assert.equal(saved.paperBinding, 'bound');
  const metadata = structuredClone(selection(value).selectedPapers[1]); delete metadata.sha256;
  assert.equal(saved.paper.sha256, sourceHash(metadata)); assert.equal(saved.paper.evidenceId, 'paper-fisher');
  const manifest = await buildExperimentManifest(value.projectId, 'paper-run', { plan: { execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: 0 } }, root, { replicationContext: saved });
  assert.equal(manifest.protocol, plan(value).note); assert.deepEqual(manifest.evaluationProtocol, protocol);
  assert.equal(manifest.seed, '0'); assert.deepEqual(manifest.successCriteria, [plan(value).expectedMetrics]);
  assert.equal(manifestSummary(manifest).paper.sha256, saved.paper.sha256);
  assert.deepEqual(manifestSummary(manifest).evaluationProtocol, protocol);
  const summary = experimentRunSummary({ id: manifest.id, status: 'failed', manifest, execution: { exitCode: 7 }, error: { message: 'Original implementation failure.' }, artifacts: [], metrics: [] });
  assert.equal(summary.paper.id, 'fisher-1936'); assert.deepEqual(summary.evaluationProtocol, protocol);
  assert.equal(summary.protocol, plan(value).note); assert.equal(summary.seed, '0'); assert.equal(summary.exitCode, 7);
  assert.equal(summary.errorMessage, 'Original implementation failure.'); assert.equal(summary.supportsSuccessfulFinding, false);
});

test('replication paper identity rejects missing, duplicate or withdrawn selection instead of guessing the first source', () => {
  for (const change of [value => { plan(value).paperId = 'not-selected'; }, value => { selection(value).selectedPapers.push(structuredClone(selection(value).selectedPapers[1])); },
    value => { selection(value).selectedPaperIds = ['other-paper']; }]) {
    const value = workflow('bad-paper'); change(value);
    assert.throws(() => context(value), { code: 'REPLICATION_PAPER_NOT_SELECTED' });
  }
  for (const invalid of [' padded ', null]) {
    const value = workflow('invalid-paper'); plan(value).paperId = invalid;
    assert.throws(() => context(value), { code: 'REPLICATION_PAPER_ID_INVALID' });
  }
});

test('replication launch preparation refuses changed selected source metadata and evaluation protocol even after workflow version advances', () => {
  const initial = workflow('source-drift'), saved = context(initial);
  for (const change of [value => { selection(value).selectedPapers[1].doi = 'changed-doi'; }, value => { selection(value).selectedPapers[1].authors.push('Changed author'); },
    value => { selection(value).selectedPapers[1].sourceRecords[0].externalId = 'changed-source'; }, value => { selection(value).selectedPapers[1].evidenceId = 'different-evidence'; },
    value => { plan(value).evaluationProtocol.datasetSplit = 'Different split'; }]) {
    const value = structuredClone(initial); value.version += 1; change(value);
    assert.throws(() => assertReplicationPreparationUnchangedFromWorkflow(value.projectId, value, saved), { code: 'REPLICATION_PLAN_CHANGED' });
  }
  const later = structuredClone(initial); later.version += 1;
  assert.equal(assertReplicationPreparationUnchangedFromWorkflow(later.projectId, later, saved).paper.sha256, saved.paper.sha256);
  for (const invalid of [{ ...protocol, metricExtraction: '' }, { ...protocol, datasetSplit: 'x'.repeat(4001) }, { ...protocol, extra: 'unsupported' }]) {
    const value = structuredClone(initial); plan(value).evaluationProtocol = invalid;
    assert.throws(() => context(value), { code: 'REPLICATION_EVALUATION_PROTOCOL_INVALID' });
  }
});

test('legacy replication remains creatable and explicitly unbound without fabricating a selected paper or evaluation protocol', async () => {
  const value = workflow('legacy-paper', { bound: false }); await project(value);
  const saved = context(value); assert.equal(saved.paperBinding, 'unbound'); assert.equal(saved.paper, undefined);
  const cleared = structuredClone(value); plan(cleared).paperId = ''; plan(cleared).evaluationProtocol = null;
  assert.equal(context(cleared).paperBinding, 'unbound'); assert.equal(context(cleared).paper, undefined);
  // Old saved contexts without the new unbound marker continue unchanged.
  const old = structuredClone(saved); delete old.paperBinding;
  assert.equal(assertReplicationPreparationUnchangedFromWorkflow(value.projectId, value, old).paper, undefined);
  const run = await createExperimentRun(value.projectId, { sourceStage: 'replication', expectedVersion: value.version,
    plan: { execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: 0 } });
  const summary = experimentRunSummary(run);
  assert.equal(run.manifest.replication.paperBinding, 'unbound'); assert.equal(summary.paperBinding, 'unbound');
  assert.equal(summary.paper, undefined); assert.equal(summary.evaluationProtocol, undefined);
});
