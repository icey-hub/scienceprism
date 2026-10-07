import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [new URL('../../frontend/src/app/research/workflowViewModel.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { mergeWorkflow, toResearchView, stageStatuses, replicationResultSummary } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('workflow projection keeps selection, evidence, failure and approval data across envelopes', () => {
  const input = { version: 7, activeStage: 'innovation', stages: [{ id: 'direction', state: 'complete' }, { id: 'innovation', state: 'error' }], papers: [{ id: 'p1', selected: true, evidenceId: 'e1' }, { id: 'p2', selected: false }], ideas: [{ id: 'i1', selected: true }], task: { status: 'failed', humanDecision: { decision: 'approve' }, error: { message: 'Source unavailable' } }, sourceFailures: [{ source: 'arxiv', message: 'Timeout' }] };
  for (const envelope of [input, { workflow: input }, { data: input }]) {
    const workflow = mergeWorkflow(envelope);
    const view = toResearchView(workflow);
    assert.equal(workflow.version, 7);
    assert.deepEqual(workflow.task, input.task);
    assert.deepEqual(workflow.sourceFailures, input.sourceFailures);
    assert.equal(workflow.papers[0].evidenceId, 'e1');
    assert.deepEqual(view.selectedPapers, ['p1']);
    assert.equal(view.writing.innovationCount, 1);
    assert.deepEqual(stageStatuses(workflow), { direction: 'complete', innovation: 'error' });
  }
});

test('saved search provenance survives backend and UI projections without using the next query draft', async () => {
  const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
  const { toFrontendWorkflow } = await import('../src/services/researchWorkflow/projection.js');
  const source = createWorkflowDocument('search-trace');
  const search = source.stages.find((stage) => stage.id === 'search');
  search.data = {
    query: 'original query', queries: ['original query', 'expanded query'],
    sources: ['arxiv'], requestedSources: ['arxiv', 'unregistered'],
    lastRunAt: '2026-10-04T12:00:00.000Z',
    sourceFailures: [{ source: 'unregistered', code: 'SOURCE_NOT_REGISTERED', message: 'Unavailable' }],
    aiSearchStrategy: { inclusionCriteria: ['uses retrieval'], exclusionCriteria: ['no evaluation'], rationale: 'Follow the human question.' }
  };
  const before = structuredClone(source);
  const workflow = mergeWorkflow({ workflow: toFrontendWorkflow(source) });
  workflow.search.query = 'next draft';
  const view = toResearchView(workflow);
  assert.equal(view.search.query, 'next draft');
  assert.deepEqual(view.search.queries, ['original query', 'expanded query']);
  assert.deepEqual(view.search.requestedSources, ['arxiv', 'unregistered']);
  assert.deepEqual(view.search.sources, ['arxiv']);
  assert.deepEqual(view.search.inclusionCriteria, ['uses retrieval']);
  assert.deepEqual(view.search.exclusionCriteria, ['no evaluation']);
  assert.equal(view.search.strategyRationale, 'Follow the human question.');
  assert.equal(view.search.lastRunAt, search.data.lastRunAt);
  assert.deepEqual(workflow.sourceFailures, search.data.sourceFailures);
  assert.deepEqual(source, before, 'read projections do not mutate persisted data');
  search.data = { query: 'legacy draft only' };
  const legacy = toResearchView(mergeWorkflow(toFrontendWorkflow(source)));
  assert.deepEqual(legacy.search.queries, []);
  assert.deepEqual(legacy.search.inclusionCriteria, []);
  assert.equal(legacy.search.strategyRationale, '');
});

test('direction falsification condition survives UI projection, draft editing and explicit clearing', () => {
  const saved = { question: 'Does gating reduce error?', falsificationCondition: 'No gain against the fixed baseline.' };
  const workflow = mergeWorkflow({ direction: saved });
  assert.equal(toResearchView(workflow).direction.falsificationCondition, saved.falsificationCondition);
  workflow.direction.falsificationCondition = 'Ablation matches the full model.';
  assert.equal(toResearchView(workflow).direction.falsificationCondition, 'Ablation matches the full model.');
  assert.equal(saved.falsificationCondition, 'No gain against the fixed baseline.');
  assert.equal(toResearchView(mergeWorkflow({ direction: { ...saved, falsificationCondition: '' } })).direction.falsificationCondition, '');
  assert.equal(toResearchView(mergeWorkflow({ direction: { question: 'Legacy question' } })).direction.falsificationCondition, '');
});

test('replication preparation survives backend projection, editing and clearing without implying execution', async () => {
  const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
  const { toFrontendWorkflow } = await import('../src/services/researchWorkflow/projection.js');
  const source = createWorkflowDocument('replication-preparation');
  const plan = { repository: 'code/baseline', codeVersion: 'commit-a', dataset: 'data/local.json', datasetVersion: 'sha256:recorded', environment: 'Node 22', expectedMetrics: 'Mean = 11; tolerance 0', gaps: 'GPU experiment unavailable', note: 'Reuse local data.' };
  source.stages.find(stage => stage.id === 'replication').data = { replication: plan };
  const before = structuredClone(source);
  const workflow = mergeWorkflow(toFrontendWorkflow(source));
  assert.deepEqual(toResearchView(workflow).replication, { ...plan, status: undefined });
  workflow.replication.codeVersion = 'commit-b';
  workflow.replication.gaps = '';
  assert.equal(toResearchView(workflow).replication.codeVersion, 'commit-b');
  assert.equal(toResearchView(workflow).replication.gaps, '');
  assert.deepEqual(source, before);
  const legacy = toResearchView(mergeWorkflow({ replication: { repository: 'legacy' } })).replication;
  for (const field of ['codeVersion', 'datasetVersion', 'expectedMetrics', 'gaps']) assert.equal(legacy[field], '');
  assert.equal(legacy.status, undefined);
});

test('replication projection keeps incomplete legacy Run data readable and unverified', () => {
  const run = {
    id: 'legacy-replication-run', projectId: 'project-a', status: 'completed',
    manifest: { replication: { sourceStage: 'replication', projectId: 'project-a', workflowId: 'workflow-a', workflowVersion: 2, stageStatus: 'approved', plan: { repository: 'repo', environment: 'node', dataset: 'dataset', datasetVersion: 'v1', note: 'recorded' } } }
  };
  const summary = replicationResultSummary(run);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.evidenceStatus, 'unverified');
  assert.equal(summary.supportsSuccessfulFinding, false);
  assert.equal(summary.codeVersion, '');
  assert.deepEqual(summary.dataset, { id: '', version: '' });
  assert.deepEqual(summary.metrics, []);
  assert.deepEqual(summary.artifacts, []);
});

test('writing projection preserves legacy outline and prefers completed experiment metrics', () => {
  const workflow = mergeWorkflow({ experiment: { command: 'node run.js', metrics: [{ name: 'draft' }] }, writing: { evidence: { outline: 'Evidence outline' } } });
  const matrix = { ok: false, unsupportedClaims: 1, rows: [] };
  const completed = toResearchView(workflow, matrix, { status: 'completed', metrics: [{}, {}] });
  assert.equal(completed.experiment.protocol, 'node run.js');
  assert.equal(completed.writing.metricCount, 2);
  assert.equal(completed.writing.outline, 'Evidence outline');
  assert.equal(completed.writing.claimMatrix, matrix);
  assert.equal(completed.writing.ready, false);
  assert.equal(toResearchView(workflow, matrix, { status: 'running', metrics: [{}, {}] }).writing.metricCount, 1);
});
