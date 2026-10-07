import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-stage-six-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow, updateResearchHumanInstructions } = await import('../src/services/researchWorkflow/commands.js');
const { getHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { runUiAction } = await import('../src/services/researchWorkflow/application.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/index.js');
const { getEvidenceLedger } = await import('../src/services/evidenceLedger/index.js');
const { mergePaperCandidates, validatePaperMetadata } = await import('../src/services/researchResearch/paperCandidates.js');

async function createProject(projectId) {
  const root = path.join(dataDir, projectId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  return root;
}

async function approve(projectId, stageId, note = 'human confirmed') {
  const workflow = await getResearchWorkflow(projectId);
  const approved = await approveResearchWorkflow(projectId, { stageId, expectedVersion: workflow.version, idempotencyKey: `${stageId}-${workflow.version}`, note });
  if (stageId === 'selection' && approved.currentStage === 'replication') {
    return approveResearchWorkflow(projectId, { stageId: 'replication', decision: 'skip', expectedVersion: approved.version, idempotencyKey: `replication-skip-${approved.version}`, note: 'No replication run in this vertical slice.' });
  }
  return approved;
}

function stageData(workflow, stageId) {
  return workflow.stages.find((stage) => stage.id === stageId)?.data || {};
}

function arxivXml() {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.00001</id><title>Evidence gated retrieval</title><summary>A method for grounded retrieval.</summary><published>2024-01-02T00:00:00Z</published><author><name>A. Researcher</name></author></entry><entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Evidence gated retrieval</title><summary>A longer method abstract.</summary><published>2024-01-02T00:00:00Z</published><author><name>A. Researcher</name></author><author><name>B. Researcher</name></author></entry></feed>`;
}

test('selection approval preserves replication until an explicit human decision', async () => {
  const { approveFromRequest } = await import('../src/services/researchWorkflow/application.js');
  for (const legacySkip of [false, true]) {
    const projectId = `replication-decision-${legacySkip}`;
    await createProject(projectId);
    let workflow = await initializeResearchWorkflow(projectId, {});
    for (const [stageId, data] of [['direction', { researchQuestion: 'Replication gate?' }], ['search', { queries: ['replication'] }], ['selection', { selectedPaperIds: ['paper-1'] }]]) {
      workflow = await updateResearchWorkflow(projectId, { stageId, data, expectedVersion: workflow.version });
      workflow = await approveFromRequest(projectId, { stage: stageId, expectedVersion: workflow.version, ...(stageId === 'selection' && legacySkip ? { keepReplication: false, skipReason: 'Dataset unavailable' } : {}) }, 'human');
    }
    const replication = workflow.stages.find((stage) => stage.id === 'replication');
    assert.equal(workflow.currentStage, legacySkip ? 'ideation' : 'replication');
    assert.equal(replication.status, legacySkip ? 'skipped' : 'in_progress');
    if (legacySkip) assert.equal(replication.skipReason, 'Dataset unavailable');
    else {
      await assert.rejects(approveFromRequest(projectId, { stage: 'replication', decision: 'skip', note: ' ', expectedVersion: workflow.version }, 'human'), { code: 'SKIP_REASON_REQUIRED' });
      assert.equal((await getResearchWorkflow(projectId)).version, workflow.version);
      workflow = await updateResearchWorkflow(projectId, { stageId: 'replication', data: { replication: { repository: 'local-baseline', note: 'Check deterministic output' } }, expectedVersion: workflow.version });
      workflow = await approveFromRequest(projectId, { stage: 'replication', expectedVersion: workflow.version }, 'human');
      assert.equal(workflow.stages.find((stage) => stage.id === 'replication').status, 'approved');
    }
  }
});

test('Source Adapter merges duplicate paper entities and preserves metadata uncertainty', () => {
  const papers = mergePaperCandidates([
    { id: '2401.00001', title: 'Evidence gated retrieval', authors: ['A'], url: 'https://arxiv.org/abs/2401.00001', source: 'arxiv' },
    { id: 'other', title: 'Evidence gated retrieval', authors: ['A', 'B'], abstract: 'Abstract', year: 2024, url: 'https://arxiv.org/abs/2401.00001v2', source: 'arxiv' }
  ]);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].sourceRecords.length, 2);
  assert.deepEqual(validatePaperMetadata(papers[0]).missing, []);
});

test('direction to writing Brief vertical slice keeps approvals, Evidence, and editor artifact', async () => {
  const projectId = 'stage-six-e2e';
  await createProject(projectId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(arxivXml(), { status: 200, headers: { 'content-type': 'application/atom+xml' } });
  try {
    let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'How can retrieval stay grounded?' } });
    workflow = await updateResearchWorkflow(projectId, { stageId: 'direction', data: { researchQuestion: 'How can retrieval stay grounded?', scope: 'long-context retrieval' }, expectedVersion: workflow.version, idempotencyKey: 'direction-update' });
    const inputStages = ['direction', 'search', 'selection', 'replication', 'ideation', 'method', 'experiment'];
    for (const stageId of inputStages) {
      workflow = await updateResearchHumanInstructions(projectId, { stageId, humanInstructions: `suggestion-${stageId}`, actor: 'human', expectedVersion: workflow.version });
    }
    const assertRunSuggestions = async (stageId, runId) => {
      const run = await getHarnessRun(projectId, runId);
      const included = inputStages.slice(0, stageId === 'writing' ? inputStages.length : inputStages.indexOf(stageId) + 1);
      for (const id of inputStages) {
        assert.equal(run.request.prompt.includes(`suggestion-${id}`), included.includes(id), `${stageId} prompt must include only current and previous suggestions: ${id}`);
        assert.equal(run.request.humanInstructions.includes(`suggestion-${id}`), included.includes(id));
      }
    };
    workflow = await approve(projectId, 'direction');

    workflow = await runUiAction(projectId, {
      action: 'search', query: 'grounded retrieval', adapter: 'fake',
      fakeResponse: JSON.stringify({ stage: 'search_strategy', researchQuestion: 'How can retrieval stay grounded?', humanDirection: 'long-context retrieval', aiAdditions: [], queries: ['grounded retrieval'], sources: ['arxiv'], inclusionCriteria: ['retrieval'], exclusionCriteria: [], rationale: 'Use the research direction as the query seed.' }),
      policy: { venueLevel: 'Any', publicationType: 'Any', peerReviewed: false, requireCode: false }
    }, 'human');
    assert.equal(stageData(workflow, 'search').task.stage, 'search');
    assert.equal(stageData(workflow, 'search').task.status, 'awaiting_approval');
    assert.equal(stageData(workflow, 'search').papers.length, 1);
    await assertRunSuggestions('search', stageData(workflow, 'search').task.harness.runId);
    const searchTaskId = stageData(workflow, 'search').task.id;
    const searchVersion = workflow.version;
    workflow = await approve(projectId, 'search');
    assert.equal(workflow.version, searchVersion + 1);
    assert.equal(stageData(workflow, 'search').task.id, searchTaskId);
    assert.equal(stageData(workflow, 'search').task.status, 'approved');
    assert.equal(stageData(workflow, 'search').task.humanDecision.decision, 'approve');
    const { listTasks } = await import('../src/services/projectHub/taskCenter.js');
    const projectedTasks = await listTasks(projectId);
    const projectedSearch = projectedTasks.find((task) => task.id === `stage:search:${searchTaskId}`);
    assert.equal(projectedSearch.status, 'approved');
    assert.equal(projectedSearch.metadata.taskId, searchTaskId);
    assert.deepEqual(projectedSearch.metadata.humanDecision, stageData(workflow, 'search').task.humanDecision);

    workflow = await runUiAction(projectId, { action: 'select-papers', paperIds: [stageData(workflow, 'search').papers[0].id] }, 'human');
    assert.equal(stageData(workflow, 'selection').selectedPaperIds?.length, 1);
    assert.equal(stageData(workflow, 'selection').evidenceIds?.length, 1);
    workflow = await approve(projectId, 'selection');
    assert.equal(workflow.currentStage, 'ideation');

    workflow = await runUiAction(projectId, {
      action: 'generate-ideas', adapter: 'fake', paperIds: stageData(workflow, 'selection').selectedPaperIds,
      fakeResponse: JSON.stringify({ stage: 'innovation_ideas', humanDirection: 'grounded retrieval', ideas: [{ id: 'idea-1', title: 'Evidence gate', problem: 'Retrieved context can be unsupported.', motivation: 'Selected paper exposes the gap.', hypothesis: 'Evidence gating reduces unsupported context.', novelty: 'Candidate mechanism only.', relatedPaperIds: [stageData(workflow, 'selection').selectedPaperIds[0]], validationPlan: ['Compare groundedness on a held-out set.'], risks: [], confidence: 0.5 }], comparison: [], caveats: [] })
    }, 'human');
    await assertRunSuggestions('ideation', stageData(workflow, 'ideation').task.harness.runId);
    workflow = await approve(projectId, 'ideation');

    workflow = await runUiAction(projectId, { action: 'generate-method', adapter: 'fake', ideaIds: ['idea-1'], fakeResponse: JSON.stringify({ stage: 'method_proposals', selectedIdeaId: 'idea-1', proposals: [{ id: 'method-1', name: 'Evidence gate', ideaId: 'idea-1', description: 'Gate retrieved context by source support.', components: ['evidence check'], assumptions: ['source metadata is available'], baselines: ['plain retrieval'], metrics: ['groundedness'], ablations: [], implementationRisks: [] }], recommendation: 'method-1', humanDecisionRequired: true }) }, 'human');
    await assertRunSuggestions('method', stageData(workflow, 'method').task.harness.runId);
    workflow = await approve(projectId, 'method');

    workflow = await runUiAction(projectId, { action: 'run-experiment', experiment: { dataset: 'held-out', command: 'record-only', metrics: ['groundedness'] } }, 'human');
    workflow = await approve(projectId, 'experiment');

    const evidence = await getEvidenceLedger(projectId);
    const paperEvidenceId = evidence.entries.find((entry) => entry.kind === 'paper')?.id;
    assert.ok(paperEvidenceId);
    const writingResponse = JSON.stringify({ stage: 'writing_brief', title: 'Grounded Retrieval', claims: [{ id: 'claim-1', text: 'The selected paper motivates evidence gating.', evidenceIds: [paperEvidenceId], confidence: 0.5 }], outline: ['Introduction', 'Method'], citationPaperIds: [stageData(workflow, 'selection').selectedPaperIds[0]], limitations: ['The experiment is only a plan.'], unsupportedClaims: [] });
    workflow = await runUiAction(projectId, {
      action: 'handoff-writing', adapter: 'fake', fakeResponse: writingResponse,
      experiment: { metrics: [{ name: 'gcn_auprc_mean', value: 0.062 }], resultRun: { id: 'run-1', codeSnapshotHash: 'snapshot-hash' } }
    }, 'human');
    assert.equal(stageData(workflow, 'writing').ready, true);
    await assertRunSuggestions('writing', stageData(workflow, 'writing').task.harness.runId);
    assert.equal(stageData(workflow, 'writing').briefPath, 'research/writing-brief.md');
    // The stage input must carry the Evidence Ledger. It used to carry selected
    // papers only, so a brief about the project's own experiment reported that
    // experiment's Evidence as absent while it sat in the ledger the whole time.
    const writingInput = stageData(workflow, 'writing').task?.input;
    assert.ok(Array.isArray(writingInput?.evidenceLedger), 'the writing input must carry the Evidence Ledger');
    assert.equal(writingInput?.experiment?.metrics?.[0]?.value, 0.062, 'the writing handoff must carry completed-run metrics');
    assert.equal(writingInput?.experiment?.resultRun?.codeSnapshotHash, 'snapshot-hash', 'the writing handoff must carry run provenance');
    assert.ok(
      writingInput.evidenceLedger.every((entry) => typeof entry.id === 'string' && typeof entry.kind === 'string'),
      'ledger entries must carry id and kind so a claim can cite them precisely'
    );
    assert.equal(stageData(workflow, 'writing').task.delegation, null, 'the default handoff keeps the single-Agent path');
    workflow = await runUiAction(projectId, {
      action: 'handoff-writing', agentMode: 'multi-agent', adapter: 'fake', fakeResponse: writingResponse,
      fakeReviewResponses: { 'claim-evidence-audit': 'The evidence is limited.', 'method-consistency-review': '' }
    }, 'human');
    const failedDelegation = stageData(workflow, 'writing').task;
    assert.equal(failedDelegation.status, 'failed');
    assert.equal(failedDelegation.error.code, 'CHILD_REVIEW_FAILED');
    assert.equal(failedDelegation.delegation.children[0].status, 'completed');
    assert.equal(workflow.currentStage, 'writing');
    workflow = await runUiAction(projectId, {
      action: 'handoff-writing', agentMode: 'multi-agent', adapter: 'fake', fakeResponse: writingResponse,
      fakeReviewResponses: {
        'claim-evidence-audit': 'Review opinion: the selected paper ID supports only the motivation claim.',
        'method-consistency-review': 'Review opinion: the experiment is still only a plan.'
      }
    }, 'human');
    const delegatedTask = stageData(workflow, 'writing').task;
    assert.equal(delegatedTask.status, 'awaiting_approval');
    assert.equal(delegatedTask.delegation.children.length, 2);
    assert.equal(delegatedTask.delegation.children[0].runId, failedDelegation.delegation.children[0].runId);
    assert.equal(delegatedTask.harness.runId, delegatedTask.delegation.parentRunId);
    assert.equal(workflow.currentStage, 'writing', 'multiple Agents must not approve the stage');
    const brief = await readFile(path.join(dataDir, projectId, 'research/writing-brief.md'), 'utf8');
    assert.match(brief, /claim-1/);
    assert.match(brief, new RegExp(paperEvidenceId));
    assert.match(brief, new RegExp(delegatedTask.delegation.children[0].runId));
    const finalLedger = await getEvidenceLedger(projectId);
    assert.ok(finalLedger.entries.some((entry) => entry.kind === 'paper-claim'));

    const completed = await approve(projectId, 'writing');
    const completedVersion = completed.version;
    const refreshed = await runUiAction(projectId, {
      action: 'handoff-writing', adapter: 'fake',
      fakeResponse: JSON.stringify({ ...JSON.parse(writingResponse), title: 'Grounded Retrieval — Updated Evidence' })
    }, 'human');
    assert.equal(refreshed.status, 'completed', 'refreshing an artifact must not reopen the completed workflow');
    assert.equal(refreshed.version, completedVersion, 'artifact refresh must not rewrite immutable workflow history');
    const refreshedBrief = await readFile(path.join(dataDir, projectId, 'research/writing-brief.md'), 'utf8');
    assert.match(refreshedBrief, /Grounded Retrieval — Updated Evidence/, 'the derived brief should refresh from current Evidence');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('writing handoff uses server-derived replication Run data instead of forged client experiment fields', async () => {
  process.env.NODE_ENV = 'test';
  const projectId = 'replication-writing-handoff';
  const root = await createProject(projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));

  const { createExperimentRun, decideExperimentRun, startExperimentRun } = await import('../src/services/experimentRunner/index.js');
  let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Can the reported result be reproduced?' } });
  const approveStageWithData = async (stageId, data) => {
    workflow = await updateResearchWorkflow(projectId, { stageId, data, expectedVersion: workflow.version, actor: 'human' });
    workflow = await approveResearchWorkflow(projectId, { stageId, expectedVersion: workflow.version, actor: 'human' });
  };

  await approveStageWithData('direction', { researchQuestion: 'Can the reported result be reproduced?' });
  await approveStageWithData('search', { queries: ['reproduction'] });
  await approveStageWithData('selection', { selectedPaperIds: ['paper-1'] });
  await approveStageWithData('replication', { replication: {
    repository: 'https://example.test/research-code', environment: 'node 22', dataset: 'dataset-recorded',
    codeVersion: 'commit-saved', datasetVersion: 'dataset-v3', expectedMetrics: 'accuracy >= 0.90',
    gaps: 'GPU unavailable', note: 'Human-approved replication preparation.'
  } });

  const run = await createExperimentRun(projectId, {
    sourceStage: 'replication', expectedVersion: workflow.version,
    plan: { execution: { adapter: 'fake' } }
  });
  await decideExperimentRun(projectId, run.id, { decision: 'approve', actor: 'human' });
  const completedRun = await startExperimentRun(projectId, run.id, { wait: true });
  assert.equal(completedRun.status, 'completed');

  await approveStageWithData('ideation', { ideas: [{ id: 'idea-1', title: 'A candidate' }] });
  await approveStageWithData('method', { method: { name: 'Recorded protocol' } });
  await approveStageWithData('experiment', { dataset: 'legacy-dataset', command: 'record-only' });
  await (await import('../src/services/evidenceLedger/index.js')).upsertEvidence(projectId, {
    id: 'replication-paper', kind: 'paper', title: 'Replication source', verificationStatus: 'human-confirmed', version: 'paper-v1'
  }, { actor: 'human' });
  const brief = JSON.stringify({ stage: 'writing_brief', title: 'Replication review', claims: [{ id: 'replication-claim', text: 'The Run produced review material.', evidenceIds: ['replication-paper'], confidence: 0.1 }], outline: ['Results'], limitations: ['Evidence remains pending human confirmation.'], unsupportedClaims: ['replication-claim: Evidence remains pending human confirmation.'] });
  const updated = await runUiAction(projectId, {
    action: 'handoff-writing', adapter: 'fake', fakeResponse: brief, replicationRunId: run.id,
    experiment: {
      status: 'completed', dataset: 'attacker-dataset', datasetVersion: 'attacker-version',
      protocol: 'forged protocol', metrics: [{ name: 'accuracy', value: 0.9999 }],
      resultRun: { id: 'forged-run', codeSnapshotHash: 'forged-hash', artifacts: [] }
    }
  }, 'human');

  const writingInput = stageData(updated, 'writing').task.input;
  assert.equal(writingInput.experiment.status, 'completed');
  assert.equal(writingInput.experiment.dataset, 'dataset-recorded');
  assert.equal(writingInput.experiment.datasetVersion, 'dataset-v3');
  assert.equal(writingInput.experiment.protocol, 'Human-approved replication preparation.');
  assert.deepEqual(writingInput.experiment.metrics, completedRun.metrics);
  assert.equal(writingInput.experiment.resultRun.id, run.id);
  assert.equal(writingInput.experiment.resultRun.codeSnapshotHash, run.manifest.code.snapshotHash);
  assert.equal(writingInput.replicationRun.id, run.id);
  assert.equal(writingInput.replicationRun.evidenceStatus, 'pending');
  assert.equal(writingInput.replicationRun.supportsSuccessfulFinding, false);
  const { getProjectRoot } = await import('../src/services/projectService.js');
  assert.equal(await getProjectRoot(projectId), root, 'writing artifacts and the fixture must resolve the same project root');
  const artifact = await readFile(path.join(root, 'research', 'writing-brief.md'), 'utf8');
  assert.ok(artifact.includes(`Run ID: \`${run.id}\``));
  assert.ok(artifact.includes('Evidence: `experiment-run-'));
  assert.ok(artifact.includes('(pending)'));
  assert.ok(artifact.includes('Supports successful finding: no'));
});

test('writing handoff rejects a missing replication Run reference at the public UI seam', async () => {
  const projectId = 'replication-writing-missing-run';
  await createProject(projectId);
  await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Can the reported result be reproduced?' } });

  await assert.rejects(
    () => runUiAction(projectId, {
      action: 'handoff-writing', adapter: 'fake', replicationRunId: 'experiment-run-missing',
      fakeResponse: JSON.stringify({ stage: 'writing_brief', title: 'Missing Run', claims: [], outline: [], limitations: [], unsupportedClaims: [] })
    }, 'human'),
    (error) => error?.code === 'REPLICATION_RUN_NOT_FOUND' && error?.statusCode === 404
  );
});

test('writing handoff rejects a replication Run from another project at the public UI seam', async () => {
  process.env.NODE_ENV = 'test';
  const sourceProjectId = 'replication-writing-foreign-source';
  const targetProjectId = 'replication-writing-foreign-target';
  await createProject(sourceProjectId);
  await createProject(targetProjectId);
  for (const projectId of [sourceProjectId, targetProjectId]) {
    const root = path.join(dataDir, projectId);
    await mkdir(path.join(root, '.scienceprism'), { recursive: true });
    await writeFile(path.join(root, '.scienceprism', 'project-constraints.json'), JSON.stringify({ capabilities: ['project.read', 'experiment.execute'] }));
  }
  const { createExperimentRun } = await import('../src/services/experimentRunner/index.js');
  let sourceWorkflow = await initializeResearchWorkflow(sourceProjectId, { data: { researchQuestion: 'Can the reported result be reproduced?' } });
  const prepareSource = async (stageId, data) => {
    sourceWorkflow = await updateResearchWorkflow(sourceProjectId, { stageId, data, expectedVersion: sourceWorkflow.version, actor: 'human' });
    sourceWorkflow = await approveResearchWorkflow(sourceProjectId, { stageId, expectedVersion: sourceWorkflow.version, actor: 'human' });
  };
  await prepareSource('direction', { researchQuestion: 'Can the reported result be reproduced?' });
  await prepareSource('search', { queries: ['reproduction'] });
  await prepareSource('selection', { selectedPaperIds: ['paper-1'] });
  await prepareSource('replication', { replication: { repository: 'https://example.test/research-code', environment: 'node 22', dataset: 'source-dataset', codeVersion: 'source-commit', datasetVersion: 'source-v1', note: 'Source preparation.' } });
  const foreignRun = await createExperimentRun(sourceProjectId, { sourceStage: 'replication', expectedVersion: sourceWorkflow.version, plan: { execution: { adapter: 'fake' } } });

  await initializeResearchWorkflow(targetProjectId, { data: { researchQuestion: 'Can the target result be reproduced?' } });
  await assert.rejects(
    () => runUiAction(targetProjectId, {
      action: 'handoff-writing', adapter: 'fake', replicationRunId: foreignRun.id,
      fakeResponse: JSON.stringify({ stage: 'writing_brief', title: 'Foreign Run', claims: [], outline: [], limitations: [], unsupportedClaims: [] })
    }, 'human'),
    (error) => error?.code === 'REPLICATION_RUN_NOT_FOUND' && error?.statusCode === 404
  );
});

test('failed stage task is persisted without changing the confirmed previous stage', async () => {
  const projectId = 'stage-six-retry';
  await createProject(projectId);
  let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'Question' } });
  workflow = await approve(projectId, 'direction');
  const failed = await runUiAction(projectId, { action: 'search', query: 'query', adapter: 'fake', fakeError: 'temporary failure' }, 'human');
  assert.equal(stageData(failed, 'search').task.status, 'failed');
  assert.equal(failed.stages.find((stage) => stage.id === 'direction').status, 'approved');
  assert.equal(failed.currentStage, 'search');
});

test('an unregistered source name from the model is reported and still searches the registered source', async () => {
  const projectId = 'stage-six-unregistered-source';
  await createProject(projectId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(arxivXml(), { status: 200, headers: { 'content-type': 'application/atom+xml' } });
  try {
    let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'How can retrieval stay grounded?' } });
    workflow = await approve(projectId, 'direction');

    // This is the shape a real model produced: venue descriptions instead of
    // registered Source Adapter ids. Before the fix the stage reported
    // validation.ok=true while silently searching nothing and returning 0 papers.
    workflow = await runUiAction(projectId, {
      action: 'search',
      query: 'grounded retrieval',
      adapter: 'fake',
      fakeResponse: JSON.stringify({
        stage: 'search_strategy',
        researchQuestion: 'How can retrieval stay grounded?',
        humanDirection: 'long-context retrieval',
        aiAdditions: [],
        queries: ['grounded retrieval'],
        sources: ['arXiv (cs.CL, cs.IR) — preprint server, useful for recency'],
        inclusionCriteria: ['retrieval'],
        exclusionCriteria: [],
        rationale: 'Use the research direction as the query seed.'
      }),
      policy: { venueLevel: 'Any', publicationType: 'Any', peerReviewed: false, requireCode: false }
    }, 'human');

    const search = stageData(workflow, 'search');
    assert.deepEqual(search.sources, ['arxiv'], 'the registered source is used instead of the prose name');
    assert.equal(search.unregisteredSources.length, 1);
    assert.ok(search.sourceFailures.some((failure) => failure.code === 'SOURCE_NOT_REGISTERED'));
    assert.equal(search.papers.length, 1, 'the fallback source still produced a paper');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed ideation Harness Run leaves the stage empty instead of fabricating ideas', async () => {
  const projectId = 'stage-six-no-fabricated-ideas';
  await createProject(projectId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(arxivXml(), { status: 200, headers: { 'content-type': 'application/atom+xml' } });
  try {
    let workflow = await initializeResearchWorkflow(projectId, { data: { researchQuestion: 'How can retrieval stay grounded?' } });
    workflow = await approve(projectId, 'direction');
    workflow = await runUiAction(projectId, {
      action: 'search',
      query: 'grounded retrieval',
      adapter: 'fake',
      fakeResponse: JSON.stringify({ stage: 'search_strategy', researchQuestion: 'How can retrieval stay grounded?', humanDirection: 'long-context retrieval', aiAdditions: [], queries: ['grounded retrieval'], sources: ['arxiv'], inclusionCriteria: ['retrieval'], exclusionCriteria: [], rationale: 'Use the research direction as the query seed.' }),
      policy: { venueLevel: 'Any', publicationType: 'Any', peerReviewed: false, requireCode: false }
    }, 'human');
    workflow = await approve(projectId, 'search');
    workflow = await runUiAction(projectId, { action: 'select-papers', paperIds: [stageData(workflow, 'search').papers[0].id] }, 'human');
    workflow = await approve(projectId, 'selection');

    const failed = await runUiAction(projectId, { action: 'generate-ideas', adapter: 'fake', fakeError: 'model unavailable' }, 'human');
    const ideation = stageData(failed, 'ideation');

    assert.deepEqual(ideation.ideas, [], 'a failed Run must not manufacture ideas in code');
    assert.equal(ideation.task.status, 'failed');
    await assert.rejects(
      () => approve(projectId, 'ideation'),
      (error) => error.code === 'STAGE_NOT_READY',
      'the readiness gate must block approval of an empty ideation stage'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
