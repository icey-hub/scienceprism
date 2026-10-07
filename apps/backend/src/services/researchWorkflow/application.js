import crypto from 'node:crypto';
import { getEnv } from '../../config/constants.js';
import { applyQualityGate, listResearchSkills, resolveResearchSkillBindings, runResearchStage, validateResearchSkillBindings, normalizeQualityPolicy } from '../researchResearch/index.js';
import { mergePaperCandidates, prioritizePaperCandidates } from '../researchResearch/paperCandidates.js';
import { listResearchSourceAdapters, searchResearchSources } from '../researchSources/index.js';
import { getEvidenceLedger, upsertEvidence, linkEvidence } from '../evidenceLedger/index.js';
import { getExperimentRun, replicationRunSummary } from '../experimentRunner/index.js';
import { createStageTask } from './stageTask.js';
import { writeWritingBriefArtifact } from './writingBriefArtifact.js';
import { runWritingDelegation } from './writingDelegation.js';
import {
  approveResearchWorkflow,
  getResearchWorkflow,
  getResearchSkillBindings,
  initializeResearchWorkflow,
  recoverResearchWorkflow,
  resetResearchWorkflow,
  updateResearchSkillBindings,
  updateResearchWorkflow
} from './index.js';
import { getStageData } from './queries.js';
import { toFrontendWorkflow, UI_TO_STAGE } from './projection.js';
import { ResearchWorkflowError, sanitizeHumanInstructions } from './errors.js';
import { saveResearchDirection, selectResearchIdeas, selectResearchPapers, updateResearchHumanInstructions } from './commands.js';
import { RESEARCH_WORKFLOW_STAGES } from './stageContracts.js';

const ACTION_STAGES = { search: 'search', 'select-papers': 'selection', 'generate-ideas': 'ideation', 'select-ideas': 'ideation', 'generate-method': 'method', 'save-method': 'method', 'run-experiment': 'experiment', 'handoff-writing': 'writing' };

function researchHumanInstructions(workflow, stageId, override) {
  const instructions = { ...(workflow.humanInstructions || {}) };
  if (override !== undefined) instructions[stageId] = sanitizeHumanInstructions(override);
  const stageIndex = RESEARCH_WORKFLOW_STAGES.findIndex((item) => item.id === stageId);
  return RESEARCH_WORKFLOW_STAGES.slice(0, stageIndex + 1)
    .filter((item) => instructions[item.id]?.trim())
    .map((item) => `${item.label} — 人工建议：\n${instructions[item.id]}`)
    .join('\n\n');
}

export function uiStageId(value) {
  return UI_TO_STAGE[value] || value;
}

export function stageData(workflow, id) {
  return getStageData(workflow, id);
}

export function selectedPaperIdsFrom(workflow) {
  const data = stageData(workflow, 'selection');
  return new Set(data.selectedPaperIds || data.paperIds || []);
}

function workflowOptions(body, actor) {
  return {
    actor,
    note: body.note,
    expectedVersion: body.expectedVersion ?? body.version,
    idempotencyKey: body.idempotencyKey || body.requestId
  };
}

function requestPolicy(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  let configuredCatalog = {};
  try {
    const rawCatalog = getEnv('CCF_VENUE_CATALOG_JSON');
    configuredCatalog = rawCatalog ? JSON.parse(rawCatalog) : {};
  } catch {
    configuredCatalog = {};
  }
  return normalizeQualityPolicy({
    requiredVenueLevels: source.venueLevel && source.venueLevel !== 'Any' ? [source.venueLevel] : [],
    allowedPublicationTypes: source.publicationType && source.publicationType !== 'Any' ? [source.publicationType] : [],
    minYear: source.yearFrom,
    maxYear: source.yearTo,
    peerReviewedOnly: Boolean(source.peerReviewed),
    requireCode: Boolean(source.requireCode),
    unknownMetadata: 'needs-review',
    venueCatalog: { ...configuredCatalog, ...(source.venueCatalog || {}) }
  });
}

function taskValidation(validation, warnings = []) {
  return {
    ok: validation?.ok !== false,
    errors: Array.isArray(validation?.errors) ? validation.errors : [],
    warnings: [...(Array.isArray(validation?.warnings) ? validation.warnings : []), ...warnings]
  };
}

function hasOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

async function readReplicationHandoff(projectId, replicationRunId) {
  if (replicationRunId === undefined || replicationRunId === null || replicationRunId === '') return null;
  if (typeof replicationRunId !== 'string' || !replicationRunId.trim()) throw new ResearchWorkflowError(400, 'INVALID_REPLICATION_RUN_ID', 'replicationRunId must be a non-empty Run ID.');
  let run;
  try {
    run = await getExperimentRun(projectId, replicationRunId.trim());
  } catch (error) {
    if (error?.code === 'EXPERIMENT_RUN_NOT_FOUND') throw new ResearchWorkflowError(404, 'REPLICATION_RUN_NOT_FOUND', 'The requested replication Run does not belong to this project or does not exist.');
    throw error;
  }
  if (!run.manifest?.replication || run.manifest.replication.projectId !== projectId || run.manifest.replication.sourceStage !== 'replication') {
    throw new ResearchWorkflowError(409, 'REPLICATION_RUN_PROVENANCE_INVALID', 'The selected Run is not a replication Run for this project.');
  }
  const summary = replicationRunSummary(run, (await getEvidenceLedger(projectId)).entries);
  if (!summary) throw new ResearchWorkflowError(409, 'REPLICATION_RUN_PROVENANCE_INVALID', 'The selected Run has no server-recorded replication provenance.');
  return summary;
}

function handoffExperiment(workflow, body, replicationRun = null) {
  const saved = stageData(workflow, 'experiment');
  const client = body.experiment && typeof body.experiment === 'object' && !Array.isArray(body.experiment) ? body.experiment : {};
  // Keep the legacy ordinary-experiment handoff contract. Replication results
  // use the separate server-derived replicationRun field below, so client
  // metrics and provenance cannot override that authoritative context.
  if (!replicationRun) return hasOwn(body, 'experiment') ? client : saved;
  return {
    ...saved,
    status: replicationRun.status,
    dataset: replicationRun.dataset?.id || saved.dataset || '',
    datasetVersion: replicationRun.dataset?.version || saved.datasetVersion || '',
    protocol: replicationRun.provenance?.plan?.note || saved.protocol || '',
    metrics: replicationRun.metrics,
    resultRun: {
      id: replicationRun.id,
      status: replicationRun.status,
      codeSnapshotHash: replicationRun.codeSnapshotHash,
      dataset: replicationRun.dataset,
      artifacts: replicationRun.artifacts
    }
  };
}

async function updateStage(projectId, stageId, data, body, actor) {
  return updateResearchWorkflow(projectId, { ...workflowOptions(body, actor), stageId, data });
}

export async function runUiAction(projectId, body, actor) {
  const action = body.action;
  const workflow = await getResearchWorkflow(projectId);
  const humanInstructions = researchHumanInstructions(workflow, ACTION_STAGES[action], body.humanInstructions);
  if (action === 'search') {
    const direction = body.direction || {};
    const query = String(body.query || direction.question || '').trim();
    if (!query) throw new ResearchWorkflowError(400, 'MISSING_QUERY', 'A search query or research question is required.');
    const registeredSources = listResearchSourceAdapters().map((adapter) => adapter.id);
    const strategy = await runResearchStage({ stage: 'search_strategy', projectId, input: { researchQuestion: direction.question || query, humanDirection: JSON.stringify(direction), seedQuery: query, availableSources: registeredSources }, humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const queries = strategy.ok && strategy.output?.queries?.length ? [...new Set([query, ...strategy.output.queries.map(String)])].slice(0, 4) : [query];
    // A model names sources in prose ("arXiv (cs.CL) - preprint server") unless it
    // is told the registered ids, so keep only ids the Source Adapter seam can
    // resolve and report the rest, instead of silently searching nothing.
    const requestedSources = (strategy.ok && strategy.output?.sources?.length ? strategy.output.sources : (body.sources || registeredSources)).map((value) => String(value).trim().toLowerCase());
    const sources = requestedSources.filter((id) => registeredSources.includes(id));
    const unregisteredSources = requestedSources.filter((id) => !registeredSources.includes(id));
    const effectiveSources = sources.length ? sources : registeredSources;
    const sourceSearch = await searchResearchSources({ queries, sources: effectiveSources, maxResults: body.maxResults });
    const sourceFailures = [
      ...unregisteredSources.map((id) => ({ source: id, code: 'SOURCE_NOT_REGISTERED', message: `Requested source is not a registered Source Adapter. Registered sources: ${registeredSources.join(', ')}.` })),
      ...sourceSearch.failures
    ];
    const rawPapers = prioritizePaperCandidates(mergePaperCandidates(sourceSearch.batches.flatMap((batch) => batch.candidates)), { sourcePriorities: { arxiv: 10, ...(body.sourcePriorities || {}) } });
    const policy = requestPolicy(body.policy);
    const gated = applyQualityGate(rawPapers, policy);
    const task = createStageTask({
      stage: 'search',
      input: { direction, query, requestedSources, effectiveSources, registeredSources, policy: body.policy || {} },
      output: { strategy: strategy.ok ? strategy.output : null, papers: rawPapers, evaluations: gated.results, sourceFailures },
      validation: taskValidation(strategy.validation, sourceFailures.map((failure) => `Source ${failure.source} failed or is unavailable.`)),
      harness: strategy,
      adapters: ['quality-gate', ...sourceSearch.batches.map((batch) => batch.source)],
      error: sourceSearch.batches.length || strategy.ok ? null : new Error('All configured research sources failed.')
    });
    return updateStage(projectId, 'search', { query, queries, sources: effectiveSources, requestedSources, unregisteredSources, papers: rawPapers, evaluations: gated.results, policy: body.policy || {}, lastRunAt: new Date().toISOString(), qualitySummary: gated.summary, sourceFailures, aiSearchStrategy: strategy.ok ? strategy.output : { ok: false, validation: strategy.validation }, task }, body, actor);
  }
  if (action === 'select-papers') {
    return selectResearchPapers(projectId, { ...workflowOptions(body, actor), paperIds: body.paperIds, reviews: body.reviews });
  }
  if (action === 'generate-ideas') {
    const selectedIds = Array.isArray(body.paperIds) ? body.paperIds : [...selectedPaperIdsFrom(workflow)];
    const papers = (stageData(workflow, 'selection').selectedPapers || stageData(workflow, 'search').papers || []).filter((paper) => selectedIds.includes(String(paper.id)) || selectedIds.includes(paper.id));
    const harness = await runResearchStage({ stage: 'innovation_ideas', projectId, input: { papers, direction: body.direction || stageData(workflow, 'direction') }, humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    // No fabricated fallback: a failed Harness Run leaves the stage empty so the
    // readiness gate blocks approval. Manufacturing placeholder ideas in code
    // produced content that looked like AI output but had no Run, model, context,
    // or provenance behind it.
    const ideas = harness.ok && harness.output?.ideas ? harness.output.ideas : [];
    const task = createStageTask({ stage: 'ideation', input: { paperIds: selectedIds, direction: body.direction || stageData(workflow, 'direction') }, output: harness.ok ? harness.output : { ideas }, validation: taskValidation(harness.validation, []), harness, adapters: ['harness', 'evidence-ledger'] });
    return updateStage(projectId, 'ideation', { ideas, innovationPoints: ideas, humanDirection: harness.ok ? harness.output?.humanDirection || '' : '', comparison: harness.ok ? harness.output?.comparison || [] : [], caveats: harness.ok ? harness.output?.caveats || [] : [], harness: { ok: harness.ok, validation: harness.validation }, task }, body, actor);
  }
  if (action === 'select-ideas') {
    return selectResearchIdeas(projectId, { ...workflowOptions(body, actor), ideaIds: body.ideaIds, reviews: body.reviews });
  }
  if (action === 'generate-method') {
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const selected = ideas.filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    const harness = await runResearchStage({ stage: 'method_proposals', projectId, input: { ideas: selected }, humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const proposals = harness.ok && harness.output?.proposals?.length ? harness.output.proposals : [];
    const method = proposals[0] ? { ...proposals[0], title: proposals[0].name } : {};
    const task = createStageTask({ stage: 'method', input: { selectedIdeaIds: selected.map((idea) => idea.id) }, output: { stage: harness.output, proposals }, validation: taskValidation(harness.validation, []), harness, adapters: ['harness', 'human-decision'] });
    return updateStage(projectId, 'method', { method, methodPlan: method, methodProposals: proposals, harness: { ok: harness.ok, validation: harness.validation }, task }, body, actor);
  }
  if (action === 'save-method') return updateStage(projectId, 'method', { method: body.method || {}, task: createStageTask({ stage: 'method', input: { method: body.method || {} }, output: { method: body.method || {} }, validation: { ok: true, errors: [], warnings: [] }, adapters: ['human-decision'] }) }, body, actor);
  if (action === 'run-experiment') {
    const experiment = body.experiment || {};
    if (!experiment.dataset || !experiment.command) throw new ResearchWorkflowError(400, 'EXPERIMENT_INCOMPLETE', 'Dataset and command are required before an experiment can run.');
    return updateStage(projectId, 'experiment', { ...experiment, status: 'planned', humanApprovalRequired: true, runRequestedAt: new Date().toISOString(), task: createStageTask({ stage: 'experiment', input: { experiment }, output: { ...experiment, status: 'planned' }, validation: { ok: true, errors: [], warnings: ['This Experiment Plan must be converted to a structured Experiment Run, explicitly approved, and executed with the project experiment.execute capability.'] }, adapters: ['human-decision'] }) }, body, actor);
  }
  if (action === 'handoff-writing') {
    if (body.agentMode && !['single-agent', 'multi-agent'].includes(body.agentMode)) {
      throw new ResearchWorkflowError(400, 'INVALID_AGENT_MODE', 'agentMode must be single-agent or multi-agent.');
    }
    const completedWorkflow = workflow.status === 'completed';
    const selectedStage = stageData(workflow, 'selection');
    const selectedPapers = selectedStage.selectedPapers || [];
    const ideas = (stageData(workflow, 'ideation').ideas || []).filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    const replicationRun = await readReplicationHandoff(projectId, body.replicationRunId);
    // The Evidence Ledger belongs in the writing input.
    //
    // It was missing, so the stage could only see the papers the selection stage
    // happened to carry. Everything else the project recorded — experiment runs,
    // results, artifacts — was invisible to the writer even though the ledger is
    // the thing claims are validated against. A brief about the project's own
    // experiment therefore reported that experiment's Evidence as absent while it
    // sat in the ledger the whole time.
    //
    // Summaries are truncated because this text goes into the Context Pack, which
    // has its own token budget.
    const ledger = await getEvidenceLedger(projectId);
    const citableEvidence = ledger.entries
      .filter((entry) => entry.verificationStatus !== 'superseded')
      .slice(0, 60)
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        verificationStatus: entry.verificationStatus,
        summary: String(entry.summary || '').slice(0, 300)
      }));
    const input = {
      direction: stageData(workflow, 'direction'),
      papers: selectedPapers,
      ideas,
      method: body.method || stageData(workflow, 'method').method || {},
      experiment: handoffExperiment(workflow, body, replicationRun),
      ...(replicationRun ? { replicationRun } : {}),
      evidenceLedger: citableEvidence
    };
    const harness = body.agentMode === 'multi-agent'
      ? await runWritingDelegation({ projectId, input, humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeReviewResponses: body.fakeReviewResponses, adapter: body.adapter })
      : await runResearchStage({ stage: 'writing', projectId, input, humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const task = createStageTask({ stage: 'writing', input, output: harness.output, validation: taskValidation(harness.validation), harness, adapters: ['harness', 'evidence-ledger', ...(harness.delegation ? ['multi-agent-review'] : [])], error: harness.delegation ? harness.error : null });
    if (!harness.ok || !harness.output) {
      if (completedWorkflow) {
        throw new ResearchWorkflowError(502, 'WRITING_HANDOFF_FAILED', 'SciencePrism could not refresh the writing brief.', { validation: harness.validation });
      }
      return updateStage(projectId, 'writing', { task, ready: false, harness: { ok: harness.ok, validation: harness.validation } }, body, actor);
    }
    const brief = harness.output;
    for (const claim of brief.claims || []) {
      const claimId = `claim-${crypto.createHash('sha1').update(String(claim.id)).digest('hex').slice(0, 20)}`;
      await upsertEvidence(projectId, { id: claimId, kind: 'paper-claim', title: claim.id, summary: claim.text, verificationStatus: 'pending', metadata: { evidenceIds: claim.evidenceIds || [], confidence: claim.confidence }, evidenceVersions: claim.evidenceVersions || {} }, { actor });
      for (const evidenceId of claim.evidenceIds || []) {
        try { await linkEvidence(projectId, { type: 'supports', fromId: evidenceId, toId: claimId, actor }, { actor }); } catch { /* the claim check remains authoritative */ }
      }
    }
    const artifact = await writeWritingBriefArtifact(projectId, brief, { delegation: harness.delegation, replicationRun });
    // A completed workflow is immutable, but researchers may need to refresh
    // its derived writing brief after new Evidence is verified. Save the new
    // artifact without reopening or rewriting the completed stage history.
    if (completedWorkflow) return workflow;
    return updateStage(projectId, 'writing', { ...brief, ready: true, handoffAt: new Date().toISOString(), briefPath: artifact.path, replicationRun, evidence: { paperIds: selectedPapers.map((paper) => paper.id), ideas, method: input.method, experiment: input.experiment, ...(replicationRun ? { replicationRun } : {}) }, task }, body, actor);
  }
  throw new ResearchWorkflowError(400, 'UNKNOWN_ACTION', `Unknown research workflow action: ${action}`);
}

export async function updateFromRequest(projectId, body, actor) {
  if (Object.prototype.hasOwnProperty.call(body, 'humanInstructions')) {
    return updateResearchHumanInstructions(projectId, { ...workflowOptions(body, actor), stageId: uiStageId(body.stageId || body.stage), humanInstructions: body.humanInstructions });
  }
  if (body.direction) {
    return saveResearchDirection(projectId, { ...workflowOptions(body, actor), direction: body.direction });
  }
  const stageId = uiStageId(body.stageId || body.stage);
  const data = body.data !== undefined ? body.data : body.patch;
  if (stageId && data && !data.task) {
    const task = createStageTask({ stage: stageId, input: { data }, output: data, validation: { ok: true, errors: [], warnings: ['This stage result was entered or edited by a human.'] }, adapters: ['human-input'] });
    return updateResearchWorkflow(projectId, { ...workflowOptions(body, actor), stageId, data: { ...data, task }, status: body.status });
  }
  return updateResearchWorkflow(projectId, { ...workflowOptions(body, actor), stageId, data, patch: body.patch, status: body.status });
}

export async function approveFromRequest(projectId, body, actor) {
  const stageId = uiStageId(body.stageId || body.stage);
  const workflow = await approveResearchWorkflow(projectId, { ...workflowOptions(body, actor), stageId, decision: body.decision || 'approve' });
  // Skipping optional replication requires an explicit legacy opt-out. New
  // clients leave the stage active so a researcher can approve or skip it.
  if (stageId === 'selection' && workflow.currentStage === 'replication' && body.keepReplication === false) {
    return approveResearchWorkflow(projectId, { actor, stageId: 'replication', decision: 'skip', note: body.skipReason || '人工确认跳过论文复现。', expectedVersion: workflow.version, idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:skip-replication` : undefined });
  }
  return workflow;
}

export async function initializeFromRequest(projectId, body, actor) {
  return initializeResearchWorkflow(projectId, { data: body.data || body.initialData || {}, actor, idempotencyKey: body.idempotencyKey || body.requestId });
}

export async function resetFromRequest(projectId, body, actor) {
  return resetResearchWorkflow(projectId, { ...workflowOptions(body, actor) });
}

export async function recoverFromRequest(projectId, body, actor) {
  return recoverResearchWorkflow(projectId, { ...workflowOptions(body, actor) });
}

export async function getSkillsProjection(projectId) {
  const [catalog, bindings] = await Promise.all([listResearchSkills({ projectId }), getResearchSkillBindings(projectId)]);
  return { skills: catalog, bindings: resolveResearchSkillBindings(bindings, catalog) };
}

export async function updateSkillsFromRequest(projectId, body, actor) {
  if (!Object.prototype.hasOwnProperty.call(body, 'bindings')) throw new ResearchWorkflowError(400, 'MISSING_SKILL_BINDINGS', 'Provide a bindings object.');
  const [catalog, currentBindings] = await Promise.all([listResearchSkills({ projectId }), getResearchSkillBindings(projectId)]);
  let requestedBindings;
  try { requestedBindings = validateResearchSkillBindings(body.bindings, catalog); }
  catch (error) { throw new ResearchWorkflowError(400, 'INVALID_SKILL_BINDINGS', error instanceof Error ? error.message : 'Invalid skill bindings.'); }
  const workflow = await updateResearchSkillBindings(projectId, { ...workflowOptions(body, actor), bindings: { ...(currentBindings || {}), ...requestedBindings } });
  const bindings = resolveResearchSkillBindings(await getResearchSkillBindings(projectId), catalog);
  return { skills: catalog, bindings, workflow };
}

export { toFrontendWorkflow };
