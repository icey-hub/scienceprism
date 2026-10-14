import test from 'node:test';
import assert from 'node:assert/strict';
import { toFrontendWorkflow } from '../src/services/researchWorkflow/projection.js';
import { createWorkflowDocument, applyStageUpdate } from '../src/services/researchWorkflow/stateMachine.js';
import { build } from 'esbuild';

const prepared = () => ({ execution: { adapter: 'python', entrypoint: 'experiments/fisher.py', args: [],
  environmentId: 'environment-11111111-1111-1111-1111-111111111111', codePreparationId: `code-preparation-${'a'.repeat(64)}` },
  resources: { timeoutMs: 5000, maxOutputBytes: 8192 }, artifacts: [{ path: 'results/metrics.json', kind: 'metric' }],
  parameters: { df: 95 }, seed: 0, codePaths: ['notes/protocol.md', 'experiments/fisher.py'] });
const metadata = () => ({ repository: 'project-workspace', environment: 'Python fixed environment', dataset: 'fixed-dataset',
  datasetVersion: 'fixed-version', note: 'Fixed paper protocol' });
function workflow(data) {
  const document = createWorkflowDocument('projection-test', { actor: 'human' });
  document.currentStage = 'replication';
  const stage = document.stages.find(item => item.id === 'replication'); stage.status = 'in_progress'; stage.data = structuredClone(data);
  return document;
}

test('automatic saved executionPlan fills missing nested replication execution with fixed code and environment IDs', () => {
  const plan = prepared(), document = workflow({ replication: metadata(), executionPlan: plan });
  const projected = toFrontendWorkflow(document).replication;
  assert.deepEqual(projected, { ...metadata(), ...plan });
  assert.equal(projected.execution.adapter, 'python'); assert.equal(projected.execution.codePreparationId, plan.execution.codePreparationId);
  assert.equal(projected.execution.environmentId, plan.execution.environmentId); assert.equal(projected.seed, 0);
});

test('explicit nested human fields win as entire fields without inheriting stale automatic IDs or budgets', () => {
  const human = { ...metadata(), execution: { adapter: 'node', entrypoint: 'manual.mjs', args: ['human'] },
    resources: {}, artifacts: [], parameters: {}, seed: 0, codePaths: [] };
  assert.deepEqual(toFrontendWorkflow(workflow({ replication: human, executionPlan: prepared() })).replication, human);
});

test('only absent nested fields fall back; explicit empty, null and false values are not guessed over', () => {
  const explicit = { ...metadata(), execution: null, parameters: null, seed: '', codePaths: [] };
  const projected = toFrontendWorkflow(workflow({ replication: explicit, executionPlan: prepared() })).replication;
  assert.equal(projected.execution, null); assert.equal(projected.parameters, null); assert.equal(projected.seed, '');
  assert.deepEqual(projected.codePaths, []); assert.deepEqual(projected.resources, prepared().resources); assert.deepEqual(projected.artifacts, prepared().artifacts);
});

test('legacy flat and replicationPlan shapes retain their original explicit execution fields', () => {
  const flat = { ...metadata(), ...prepared() };
  assert.deepEqual(toFrontendWorkflow(workflow(flat)).replication, flat);
  assert.deepEqual(toFrontendWorkflow(workflow({ replicationPlan: flat })).replication, flat);
  const human = { ...metadata(), execution: { adapter: 'node', entrypoint: 'manual.js', args: [] } };
  assert.deepEqual(toFrontendWorkflow(workflow({ replication: human, replicationPlan: flat })).replication, human);
});

test('task prose or unsaved task input is never treated as saved execution material', () => {
  const original = metadata(), document = workflow({ replication: original, task: { reply: 'Python experiment ready', input: { plan: prepared() } } });
  assert.deepEqual(toFrontendWorkflow(document).replication, original);
  assert.deepEqual(toFrontendWorkflow(workflow({ replication: original, executionPlan: 'Not an execution plan' })).replication, original);
});

test('projection does not mutate or alias saved automatic or human code fields', () => {
  const document = workflow({ replication: metadata(), executionPlan: prepared() }), before = structuredClone(document);
  const projected = toFrontendWorkflow(document).replication;
  projected.execution.entrypoint = 'changed.py'; projected.codePaths.push('changed.py'); projected.parameters.df = 98;
  assert.deepEqual(document, before);
  const humanDocument = workflow({ replication: { ...metadata(), ...prepared() } }), original = structuredClone(humanDocument);
  toFrontendWorkflow(humanDocument).replication.execution.args.push('changed');
  assert.deepEqual(humanDocument, original);
});

test('saving projected replication material keeps both fixed IDs and zero seed on round trip', () => {
  const document = workflow({ replication: metadata(), executionPlan: prepared() });
  const material = toFrontendWorkflow(document).replication;
  applyStageUpdate(document, { stageId: 'replication', actor: 'human', data: { replication: material } });
  assert.deepEqual(toFrontendWorkflow(document).replication, material);
  assert.equal(document.stages.find(item => item.id === 'replication').data.replication.execution.codePreparationId, prepared().execution.codePreparationId);
  assert.equal(document.stages.find(item => item.id === 'replication').data.replication.execution.environmentId, prepared().execution.environmentId);
});

test('the real frontend view model preserves projected Python bindings and numeric zero seed', async () => {
  const bundle = await build({ entryPoints: [new URL('../../frontend/src/app/research/workflowViewModel.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', platform: 'node' });
  const { mergeWorkflow, toResearchView } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const view = toResearchView(mergeWorkflow(toFrontendWorkflow(workflow({ replication: metadata(), executionPlan: prepared() }))));
  assert.deepEqual(view.replication.execution, prepared().execution); assert.equal(view.replication.seed, '0');
  assert.deepEqual(view.replication.artifacts, prepared().artifacts); assert.deepEqual(view.replication.codePaths, prepared().codePaths);
});
