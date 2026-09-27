import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-writing-delegation-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { runWritingDelegation } = await import('../src/services/researchWorkflow/writingDelegation.js');
const { cancelHarnessRun, getHarnessRun, listHarnessRuns, registerHarnessAdapter } = await import('../src/services/harnessRuntime/index.js');
const { fakeHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/fakeAdapter.js');
const { getEvidenceLedger, upsertEvidence } = await import('../src/services/evidenceLedger/index.js');
const { initializeResearchWorkflow, updateResearchSkillBindings } = await import('../src/services/researchWorkflow/commands.js');

async function setup(id) {
  const root = path.join(dataDir, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  await initializeResearchWorkflow(id, { data: { researchQuestion: 'How does the method work?' } });
  await upsertEvidence(id, { id: 'paper-1', kind: 'paper', title: 'Grounded study', summary: 'Evidence', verificationStatus: 'human-confirmed', version: 'v1' });
  return {
    projectId: id,
    input: { direction: { researchQuestion: 'How does the method work?' }, papers: [{ id: 'paper-1', title: 'Grounded study' }], method: {}, experiment: {}, evidenceLedger: [{ id: 'paper-1', verificationStatus: 'human-confirmed' }] },
    adapter: 'fake',
    fakeResponse: JSON.stringify({ stage: 'writing_brief', title: 'Grounded study', claims: [{ id: 'claim-1', text: 'The paper motivates the method.', evidenceIds: ['paper-1'], confidence: 0.5 }], outline: ['Introduction'], citationPaperIds: ['paper-1'], limitations: [], unsupportedClaims: [] })
  };
}

test('writing delegation executes two independent child Runs before the validated coordinator Run', async () => {
  const request = await setup('writing-delegation-sequence');
  const sequence = [];
  let active = 0;
  let peak = 0;
  let coordinatorPrompt = '';
  registerHarnessAdapter({ id: 'fake', async run({ request: runRequest }) {
    active += 1;
    peak = Math.max(peak, active);
    sequence.push(runRequest.delegationTask || 'coordinator');
    if (!runRequest.delegationTask) coordinatorPrompt = runRequest.prompt;
    const finalResponse = runRequest.fakeResponse;
    active -= 1;
    return { finalResponse, events: [], sessionId: 'probe', patches: [] };
  } });
  try {
    const result = await runWritingDelegation(request);
    assert.equal(result.ok, true, JSON.stringify(result.validation?.errors || []));
    assert.deepEqual(sequence, ['claim-evidence-audit', 'method-consistency-review', 'coordinator']);
    assert.equal(peak, 1);
    assert.equal(result.delegation.children.length, 2);
    assert.equal(result.delegation.coordinatorRunIds[0], result.delegation.parentRunId);
    assert.ok(coordinatorPrompt.includes('reviewOpinion'));
    assert.ok(result.delegation.children.every((child) => coordinatorPrompt.includes(child.runId)));
    assert.equal((await getEvidenceLedger(request.projectId)).entries.length, 1, 'review opinions must not create verified Evidence');
    for (const child of result.delegation.children) {
      const run = await getHarnessRun(request.projectId, child.runId);
      assert.equal(run.parentRunId, result.delegation.parentRunId);
      assert.deepEqual(run.capabilities.granted, ['project.read']);
      assert.deepEqual(run.skills, child.task === 'claim-evidence-audit' ? ['claim-evidence-audit'] : ['ccf-paper-review']);
    }
    assert.equal((await listHarnessRuns(request.projectId, { parentRunId: result.delegation.parentRunId })).length, 2);
  } finally {
    registerHarnessAdapter(fakeHarnessAdapter);
  }
});

test('changing Writing Skill bindings does not reuse a pending review parent', async () => {
  const request = await setup('writing-delegation-skill-change');
  let failSecond = true;
  registerHarnessAdapter({ id: 'fake', async run({ request: runRequest }) {
    if (runRequest.delegationTask === 'method-consistency-review' && failSecond) {
      failSecond = false;
      throw new Error('review interrupted');
    }
    return { finalResponse: runRequest.fakeResponse, events: [], sessionId: 'probe', patches: [] };
  } });
  try {
    const first = await runWritingDelegation(request);
    assert.equal(first.ok, false);
    await updateResearchSkillBindings(request.projectId, { bindings: { writing: ['claim-evidence-audit'] }, actor: 'human' });
    const second = await runWritingDelegation(request);
    assert.equal(second.ok, true, JSON.stringify(second.validation?.errors || []));
    assert.notEqual(second.delegation.parentRunId, first.delegation.parentRunId);
    assert.notEqual(second.delegation.children[0].runId, first.delegation.children[0].runId);
    const methodReview = await getHarnessRun(request.projectId, second.delegation.children[1].runId);
    assert.deepEqual(methodReview.skills, []);
  } finally {
    registerHarnessAdapter(fakeHarnessAdapter);
  }
});

test('retry reuses a completed child review and reruns only the failed review', async () => {
  const request = await setup('writing-delegation-retry');
  const sequence = [];
  let failSecond = true;
  registerHarnessAdapter({ id: 'fake', async run({ request: runRequest }) {
    const task = runRequest.delegationTask || 'coordinator';
    sequence.push(task);
    if (task === 'method-consistency-review' && failSecond) {
      failSecond = false;
      throw Object.assign(new Error('review interrupted'), { code: 'FAKE_FAILURE' });
    }
    return { finalResponse: runRequest.fakeResponse, events: [], sessionId: 'probe', patches: [] };
  } });
  try {
    const first = await runWritingDelegation(request);
    assert.equal(first.ok, false);
    assert.equal(first.validation.errors[0].code, 'CHILD_REVIEW_FAILED');
    assert.equal((await getHarnessRun(request.projectId, first.delegation.parentRunId)).status, 'created');
    const second = await runWritingDelegation(request);
    assert.equal(second.ok, true, JSON.stringify(second.validation?.errors || []));
    assert.equal(second.delegation.parentRunId, first.delegation.parentRunId);
    assert.equal(second.delegation.children[0].runId, first.delegation.children[0].runId);
    assert.deepEqual(sequence, ['claim-evidence-audit', 'method-consistency-review', 'method-consistency-review', 'coordinator']);
  } finally {
    registerHarnessAdapter(fakeHarnessAdapter);
  }
});

test('cancelling an active reviewer stops delegation before the coordinator starts', async () => {
  const request = await setup('writing-delegation-cancel');
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  registerHarnessAdapter({ id: 'fake', async run({ request: runRequest, signal }) {
    if (runRequest.delegationTask === 'claim-evidence-audit') {
      signalEntered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { finalResponse: runRequest.fakeResponse, events: [], sessionId: 'probe', patches: [] };
  } });
  try {
    const pending = runWritingDelegation(request);
    await entered;
    const child = (await listHarnessRuns(request.projectId)).find((run) => run.delegationTask === 'claim-evidence-audit');
    assert.equal(child?.status, 'running');
    await cancelHarnessRun(request.projectId, child.id);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.delegation.children[0].status, 'cancelled');
    assert.equal(result.delegation.coordinatorRunIds.length, 0);
    assert.equal((await getHarnessRun(request.projectId, result.delegation.parentRunId)).status, 'created');
  } finally {
    registerHarnessAdapter(fakeHarnessAdapter);
  }
});

test('a delegated coordinator still rejects claims without confirmed Evidence', async () => {
  const request = await setup('writing-delegation-evidence-gate');
  const invalid = JSON.parse(request.fakeResponse);
  invalid.claims[0].evidenceIds = ['missing-evidence'];
  request.fakeResponse = JSON.stringify(invalid);
  const result = await runWritingDelegation(request);
  assert.equal(result.ok, false);
  assert.equal(result.output, null);
  assert.ok(result.validation.errors.some((error) => error.code === 'UNSUPPORTED_CLAIM'));
  assert.equal((await getEvidenceLedger(request.projectId)).entries.length, 1);
});
