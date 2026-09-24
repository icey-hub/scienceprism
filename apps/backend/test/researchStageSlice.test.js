import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-stage-six-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { initializeResearchWorkflow, updateResearchWorkflow, approveResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
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
    workflow = await approve(projectId, 'direction');

    workflow = await runUiAction(projectId, {
      action: 'search', query: 'grounded retrieval', adapter: 'fake',
      fakeResponse: JSON.stringify({ stage: 'search_strategy', researchQuestion: 'How can retrieval stay grounded?', humanDirection: 'long-context retrieval', aiAdditions: [], queries: ['grounded retrieval'], sources: ['arxiv'], inclusionCriteria: ['retrieval'], exclusionCriteria: [], rationale: 'Use the research direction as the query seed.' }),
      policy: { venueLevel: 'Any', publicationType: 'Any', peerReviewed: false, requireCode: false }
    }, 'human');
    assert.equal(stageData(workflow, 'search').task.stage, 'search');
    assert.equal(stageData(workflow, 'search').task.status, 'awaiting_approval');
    assert.equal(stageData(workflow, 'search').papers.length, 1);
    workflow = await approve(projectId, 'search');

    workflow = await runUiAction(projectId, { action: 'select-papers', paperIds: [stageData(workflow, 'search').papers[0].id] }, 'human');
    assert.equal(stageData(workflow, 'selection').selectedPaperIds?.length, 1);
    assert.equal(stageData(workflow, 'selection').evidenceIds?.length, 1);
    workflow = await approve(projectId, 'selection');
    assert.equal(workflow.currentStage, 'ideation');

    workflow = await runUiAction(projectId, {
      action: 'generate-ideas', adapter: 'fake', paperIds: stageData(workflow, 'selection').selectedPaperIds,
      fakeResponse: JSON.stringify({ stage: 'innovation_ideas', humanDirection: 'grounded retrieval', ideas: [{ id: 'idea-1', title: 'Evidence gate', problem: 'Retrieved context can be unsupported.', motivation: 'Selected paper exposes the gap.', hypothesis: 'Evidence gating reduces unsupported context.', novelty: 'Candidate mechanism only.', relatedPaperIds: [stageData(workflow, 'selection').selectedPaperIds[0]], validationPlan: ['Compare groundedness on a held-out set.'], risks: [], confidence: 0.5 }], comparison: [], caveats: [] })
    }, 'human');
    workflow = await approve(projectId, 'ideation');

    workflow = await runUiAction(projectId, { action: 'generate-method', adapter: 'fake', ideaIds: ['idea-1'], fakeResponse: JSON.stringify({ stage: 'method_proposals', selectedIdeaId: 'idea-1', proposals: [{ id: 'method-1', name: 'Evidence gate', ideaId: 'idea-1', description: 'Gate retrieved context by source support.', components: ['evidence check'], assumptions: ['source metadata is available'], baselines: ['plain retrieval'], metrics: ['groundedness'], ablations: [], implementationRisks: [] }], recommendation: 'method-1', humanDecisionRequired: true }) }, 'human');
    workflow = await approve(projectId, 'method');

    workflow = await runUiAction(projectId, { action: 'run-experiment', experiment: { dataset: 'held-out', command: 'record-only', metrics: ['groundedness'] } }, 'human');
    workflow = await approve(projectId, 'experiment');

    const evidence = await getEvidenceLedger(projectId);
    const paperEvidenceId = evidence.entries.find((entry) => entry.kind === 'paper')?.id;
    assert.ok(paperEvidenceId);
    const writingResponse = JSON.stringify({ stage: 'writing_brief', title: 'Grounded Retrieval', claims: [{ id: 'claim-1', text: 'The selected paper motivates evidence gating.', evidenceIds: [paperEvidenceId], confidence: 0.5 }], outline: ['Introduction', 'Method'], citationPaperIds: [stageData(workflow, 'selection').selectedPaperIds[0]], limitations: ['The experiment is only a plan.'], unsupportedClaims: [] });
    workflow = await runUiAction(projectId, { action: 'handoff-writing', adapter: 'fake', fakeResponse: writingResponse }, 'human');
    assert.equal(stageData(workflow, 'writing').ready, true);
    assert.equal(stageData(workflow, 'writing').briefPath, 'research/writing-brief.md');
    const brief = await readFile(path.join(dataDir, projectId, 'research/writing-brief.md'), 'utf8');
    assert.match(brief, /claim-1/);
    assert.match(brief, new RegExp(paperEvidenceId));
    const finalLedger = await getEvidenceLedger(projectId);
    assert.ok(finalLedger.entries.some((entry) => entry.kind === 'paper-claim'));
  } finally {
    globalThis.fetch = originalFetch;
  }
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
