import crypto from 'node:crypto';
import { getEnv } from '../../config/constants.js';
import { applyQualityGate, listResearchSkills, resolveResearchSkillBindings, runResearchStage, validateResearchSkillBindings, normalizeQualityPolicy } from '../researchResearch/index.js';
import { mergePaperCandidates, prioritizePaperCandidates, validatePaperMetadata } from '../researchResearch/paperCandidates.js';
import { listResearchSourceAdapters, searchResearchSources } from '../researchSources/index.js';
import { upsertEvidence, linkEvidence } from '../evidenceLedger/index.js';
import { createStageTask } from './stageTask.js';
import { writeWritingBriefArtifact } from './writingBriefArtifact.js';
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
import { ResearchWorkflowError } from './errors.js';

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

function paperEvidenceId(paper) {
  const identity = paper?.doi || paper?.url || paper?.id || paper?.title || 'paper';
  return `paper-${crypto.createHash('sha1').update(String(identity)).digest('hex').slice(0, 20)}`;
}

async function confirmPaperEvidence(projectId, paper, actor) {
  const evidenceId = paperEvidenceId(paper);
  const version = paper.metadataUpdatedAt || paper.retrievedAt || 'retrieved';
  await upsertEvidence(projectId, {
    id: evidenceId,
    kind: 'paper',
    title: paper.title || 'Untitled paper',
    summary: paper.abstract || 'Paper metadata was selected by a human and requires source-level review.',
    sourceUrl: paper.url || null,
    acquiredAt: paper.retrievedAt || new Date().toISOString(),
    verificationStatus: 'human-confirmed',
    version,
    metadata: {
      paperId: paper.id,
      doi: paper.doi,
      authors: paper.authors,
      year: paper.year,
      venue: paper.venue,
      publicationType: paper.publicationType,
      source: paper.source,
      sourceRecords: paper.sourceRecords || [],
      metadataValidation: validatePaperMetadata(paper)
    }
  }, { actor });
  return evidenceId;
}

async function updateStage(projectId, stageId, data, body, actor) {
  return updateResearchWorkflow(projectId, { ...workflowOptions(body, actor), stageId, data });
}

export async function runUiAction(projectId, body, actor) {
  const action = body.action;
  if (action === 'search') {
    const direction = body.direction || {};
    const query = String(body.query || direction.question || '').trim();
    if (!query) throw new ResearchWorkflowError(400, 'MISSING_QUERY', 'A search query or research question is required.');
    const registeredSources = listResearchSourceAdapters().map((adapter) => adapter.id);
    const strategy = await runResearchStage({ stage: 'search_strategy', projectId, input: { researchQuestion: direction.question || query, humanDirection: JSON.stringify(direction), seedQuery: query, availableSources: registeredSources }, humanInstructions: body.humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
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
    const workflow = await getResearchWorkflow(projectId);
    const evaluations = stageData(workflow, 'search').evaluations || [];
    const requested = Array.isArray(body.paperIds) ? body.paperIds.map(String) : [];
    const accepted = new Set(evaluations.filter((item) => item.decision === 'accept').map((item) => String(item.id)));
    const blocked = requested.filter((id) => !accepted.has(id));
    if (blocked.length) throw new ResearchWorkflowError(409, 'QUALITY_GATE', 'Only papers accepted by the server-side quality gate can be selected.', { blockedPaperIds: blocked });
    const selectedPapers = evaluations.filter((item) => requested.includes(String(item.id))).map((item) => item.candidate);
    const evidenceIds = [];
    for (const paper of selectedPapers) evidenceIds.push(await confirmPaperEvidence(projectId, paper, actor));
    const task = createStageTask({ stage: 'selection', input: { requestedPaperIds: requested, qualityPolicy: stageData(workflow, 'search').policy || {} }, output: { selectedPaperIds: requested, evidenceIds }, validation: { ok: true, errors: [], warnings: [] }, adapters: ['quality-gate', 'evidence-ledger'] });
    return updateStage(projectId, 'selection', { selectedPaperIds: requested, selectedPapers: selectedPapers.map((paper, index) => ({ ...paper, evidenceId: evidenceIds[index] })), evidenceIds, policy: stageData(workflow, 'search').policy || {}, task }, body, actor);
  }
  if (action === 'generate-ideas') {
    const workflow = await getResearchWorkflow(projectId);
    const selectedIds = Array.isArray(body.paperIds) ? body.paperIds : [...selectedPaperIdsFrom(workflow)];
    const papers = (stageData(workflow, 'selection').selectedPapers || stageData(workflow, 'search').papers || []).filter((paper) => selectedIds.includes(String(paper.id)) || selectedIds.includes(paper.id));
    const harness = await runResearchStage({ stage: 'innovation_ideas', projectId, input: { papers, direction: body.direction || stageData(workflow, 'direction') }, humanInstructions: body.humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const ideas = harness.ok && harness.output?.ideas ? harness.output.ideas : papers.slice(0, 3).map((paper, index) => ({ id: `paper-gap-${index + 1}`, title: `围绕“${paper.title || '候选论文'}”的可检验扩展`, problem: '需要人工补充明确的研究缺口。', motivation: '由入选论文生成的起点，不代表已验证创新。', hypothesis: '需要人工补充可检验假设。', novelty: '尚未验证的新颖性候选。', relatedPaperIds: [paper.id].filter(Boolean), validationPlan: ['人工补充可执行的验证计划。'], risks: ['Harness 未返回结构化创新点，当前内容仅作草稿。'], selected: false }));
    const task = createStageTask({ stage: 'ideation', input: { paperIds: selectedIds, direction: body.direction || stageData(workflow, 'direction') }, output: harness.ok ? harness.output : { ideas }, validation: taskValidation(harness.validation, harness.ok ? [] : ['The fallback idea list is an unverified draft.']), harness, adapters: ['harness', 'evidence-ledger'] });
    return updateStage(projectId, 'ideation', { ideas, innovationPoints: ideas, harness: { ok: harness.ok, validation: harness.validation }, task }, body, actor);
  }
  if (action === 'select-ideas') {
    const workflow = await getResearchWorkflow(projectId);
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const ids = new Set((Array.isArray(body.ideaIds) ? body.ideaIds : []).map(String));
    const nextIdeas = ideas.map((idea) => ({ ...idea, selected: ids.has(String(idea.id)) }));
    return updateStage(projectId, 'ideation', { ideas: nextIdeas, task: createStageTask({ stage: 'ideation', input: { candidateIds: ideas.map((idea) => idea.id) }, output: { selectedIdeaIds: [...ids] }, validation: { ok: true, errors: [], warnings: [] }, adapters: ['human-decision'] }) }, body, actor);
  }
  if (action === 'generate-method') {
    const workflow = await getResearchWorkflow(projectId);
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const selected = ideas.filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    const harness = await runResearchStage({ stage: 'method_proposals', projectId, input: { ideas: selected }, humanInstructions: body.humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const proposals = harness.ok && harness.output?.proposals?.length ? harness.output.proposals : selected.map((idea, index) => ({ id: `method-draft-${index + 1}`, name: `围绕 ${idea.title || idea.id} 的方法候选`, ideaId: idea.id, description: '需要人工补充方法机制。', components: ['待补充'], assumptions: ['待人工确认'], baselines: ['待补充可比基线'], metrics: ['待补充评价指标'], ablations: [], implementationRisks: ['当前为未验证草案。'] }));
    const method = proposals[0] ? { ...proposals[0], title: proposals[0].name } : {};
    const task = createStageTask({ stage: 'method', input: { selectedIdeaIds: selected.map((idea) => idea.id) }, output: { stage: harness.output, proposals }, validation: taskValidation(harness.validation, harness.ok ? [] : ['The method candidates are an unverified draft.']), harness, adapters: ['harness', 'human-decision'] });
    return updateStage(projectId, 'method', { method, methodPlan: method, methodProposals: proposals, harness: { ok: harness.ok, validation: harness.validation }, task }, body, actor);
  }
  if (action === 'save-method') return updateStage(projectId, 'method', { method: body.method || {}, task: createStageTask({ stage: 'method', input: { method: body.method || {} }, output: { method: body.method || {} }, validation: { ok: true, errors: [], warnings: [] }, adapters: ['human-decision'] }) }, body, actor);
  if (action === 'run-experiment') {
    const experiment = body.experiment || {};
    if (!experiment.dataset || !experiment.command) throw new ResearchWorkflowError(400, 'EXPERIMENT_INCOMPLETE', 'Dataset and command are required before an experiment can run.');
    return updateStage(projectId, 'experiment', { ...experiment, status: 'planned', humanApprovalRequired: true, runRequestedAt: new Date().toISOString(), task: createStageTask({ stage: 'experiment', input: { experiment }, output: { ...experiment, status: 'planned' }, validation: { ok: true, errors: [], warnings: ['This Experiment Plan must be converted to a structured Experiment Run, explicitly approved, and executed with the project experiment.execute capability.'] }, adapters: ['human-decision'] }) }, body, actor);
  }
  if (action === 'handoff-writing') {
    const workflow = await getResearchWorkflow(projectId);
    const selectedStage = stageData(workflow, 'selection');
    const selectedPapers = selectedStage.selectedPapers || [];
    const ideas = (stageData(workflow, 'ideation').ideas || []).filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    const input = {
      direction: stageData(workflow, 'direction'),
      papers: selectedPapers,
      ideas,
      method: body.method || stageData(workflow, 'method').method || {},
      experiment: body.experiment || stageData(workflow, 'experiment')
    };
    const harness = await runResearchStage({ stage: 'writing', projectId, input, humanInstructions: body.humanInstructions, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const task = createStageTask({ stage: 'writing', input, output: harness.output, validation: taskValidation(harness.validation), harness, adapters: ['harness', 'evidence-ledger'] });
    if (!harness.ok || !harness.output) return updateStage(projectId, 'writing', { task, ready: false, harness: { ok: harness.ok, validation: harness.validation } }, body, actor);
    const brief = harness.output;
    for (const claim of brief.claims || []) {
      const claimId = `claim-${crypto.createHash('sha1').update(String(claim.id)).digest('hex').slice(0, 20)}`;
      await upsertEvidence(projectId, { id: claimId, kind: 'paper-claim', title: claim.id, summary: claim.text, verificationStatus: 'pending', metadata: { evidenceIds: claim.evidenceIds || [], confidence: claim.confidence }, evidenceVersions: claim.evidenceVersions || {} }, { actor });
      for (const evidenceId of claim.evidenceIds || []) {
        try { await linkEvidence(projectId, { type: 'supports', fromId: evidenceId, toId: claimId, actor }, { actor }); } catch { /* the claim check remains authoritative */ }
      }
    }
    const artifact = await writeWritingBriefArtifact(projectId, brief);
    return updateStage(projectId, 'writing', { ...brief, ready: true, handoffAt: new Date().toISOString(), briefPath: artifact.path, evidence: { paperIds: selectedPapers.map((paper) => paper.id), ideas, method: input.method, experiment: input.experiment }, task }, body, actor);
  }
  throw new ResearchWorkflowError(400, 'UNKNOWN_ACTION', `Unknown research workflow action: ${action}`);
}

export async function updateFromRequest(projectId, body, actor) {
  if (body.direction) {
    const direction = { topic: body.direction.question || '', researchQuestion: body.direction.question || '', seedKeywords: body.direction.keywords || [], scope: body.direction.scope || '', notes: body.direction.notes || '' };
    return updateStage(projectId, 'direction', {
      ...direction,
      task: createStageTask({ stage: 'direction', input: { direction: body.direction }, output: direction, validation: { ok: Boolean(direction.researchQuestion.trim()), errors: direction.researchQuestion.trim() ? [] : [{ code: 'MISSING_RESEARCH_QUESTION', path: 'researchQuestion', message: 'A research question is required.' }], warnings: [] }, adapters: ['human-input'] })
    }, body, actor);
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
  if (stageId === 'selection' && workflow.currentStage === 'replication' && !body.keepReplication) {
    return approveResearchWorkflow(projectId, { actor, stageId: 'replication', decision: 'skip', note: '研究工作台默认跳过可选复现阶段。', expectedVersion: workflow.version, idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:skip-replication` : undefined });
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
