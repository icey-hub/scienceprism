import { writingClaimEvidenceId } from './writingClaims.js';
import { getEnv } from '../../config/constants.js';
import { applyQualityGate, listResearchSkills, resolveResearchSkillBindings, runResearchStage, validateResearchSkillBindings, normalizeQualityPolicy } from '../researchResearch/index.js';
import { prioritizePaperCandidates } from '../researchResearch/paperCandidates.js';
import { mergeSourceCandidates, searchSessionCandidates } from '../researchSources/candidateIdentity.js';
import { searchProjectPapers } from '../paperSearch.js';
import { listResearchSourceAdapters } from '../researchSources/index.js';
import { getEvidenceLedger, upsertEvidence, linkEvidence } from '../evidenceLedger/index.js';
import { getExperimentRun, experimentRunSummary } from '../experimentRunner/index.js';
import { createStageTask } from './stageTask.js';
import { writeWritingBriefArtifact } from './writingBriefArtifact.js';
import { runWritingDelegation } from './writingDelegation.js';
import { readCampaignWritingHandoff, campaignWritingHarness } from './campaignWritingHandoff.js';
import { withWorkflowLock, resolveProjectRoot, readWorkflowFile } from './repository.js';
import { applyStageUpdate } from './stateMachine.js';
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

async function readRunHandoff(projectId, runId, sourceStage) {
  if (runId === undefined || runId === null || runId === '') return null;
  const codePrefix = sourceStage.toUpperCase();
  if (typeof runId !== 'string' || !runId.trim()) throw new ResearchWorkflowError(400, `INVALID_${codePrefix}_RUN_ID`, `${sourceStage}RunId must be a non-empty Run ID.`);
  let run;
  try {
    run = await getExperimentRun(projectId, runId.trim());
  } catch (error) {
    if (error?.code === 'EXPERIMENT_RUN_NOT_FOUND') throw new ResearchWorkflowError(404, `${codePrefix}_RUN_NOT_FOUND`, `The requested ${sourceStage} Run does not belong to this project or does not exist.`);
    throw error;
  }
  const provenance = sourceStage === 'replication' ? run.manifest?.replication : run.manifest?.researchPlan;
  if (!provenance || provenance.projectId !== projectId || provenance.sourceStage !== sourceStage) {
    throw new ResearchWorkflowError(409, `${codePrefix}_RUN_PROVENANCE_INVALID`, `The selected Run is not a ${sourceStage} Run for this project.`);
  }
  return experimentRunSummary(run, (await getEvidenceLedger(projectId)).entries);
}

function handoffExperiment(workflow, body, resultRun = null) {
  const saved = stageData(workflow, 'experiment');
  const client = body.experiment && typeof body.experiment === 'object' && !Array.isArray(body.experiment) ? body.experiment : {};
  // Older clients may send a plan without a Run. A selected Run always owns
  // the execution fields, even when it failed or was cancelled.
  if (!resultRun) return hasOwn(body, 'experiment') ? client : saved;
  return {
    ...saved,
    status: resultRun.status,
    dataset: resultRun.dataset?.id || '',
    datasetVersion: resultRun.dataset?.version || '',
    protocol: resultRun.provenance?.plan?.protocol || resultRun.provenance?.plan?.note || '',
    metrics: resultRun.metrics,
    resultRun: {
      id: resultRun.id,
      status: resultRun.status,
      codeSnapshotHash: resultRun.codeSnapshotHash,
      dataset: resultRun.dataset,
      artifacts: resultRun.artifacts
    }
  };
}

export async function runUiAction(projectId, body, actor, { signal, search = searchProjectPapers, runStage = runResearchStage, beforeCommit } = {}) {
  const updateStage = (projectId, stageId, data, body, actor) => updateResearchWorkflow(projectId, { ...workflowOptions(body, actor), stageId, data, beforeCommit });
  signal?.throwIfAborted();
  const action = body.action;
  const workflow = await getResearchWorkflow(projectId);
  signal?.throwIfAborted();
  const humanInstructions = researchHumanInstructions(workflow, ACTION_STAGES[action], body.humanInstructions);
  if (action === 'search') {
    const direction = body.direction || {};
    const query = String(body.query || direction.question || '').trim();
    if (!query) throw new ResearchWorkflowError(400, 'MISSING_QUERY', 'A search query or research question is required.');
    const registeredSources = listResearchSourceAdapters().map((adapter) => adapter.id);
    const strategy = await runStage({ stage: 'search_strategy', projectId, input: { researchQuestion: direction.question || query, humanDirection: JSON.stringify(direction), seedQuery: query, availableSources: registeredSources }, humanInstructions, role: body.role, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const queries = strategy.ok && strategy.output?.queries?.length ? [...new Set([query, ...strategy.output.queries.map(String)])].slice(0, 4) : [query];
    // A model names sources in prose ("arXiv (cs.CL) - preprint server") unless it
    // is told the registered ids, so keep only ids the Source Adapter seam can
    // resolve and report the rest, instead of silently searching nothing.
    const requestedSources = (strategy.ok && strategy.output?.sources?.length ? strategy.output.sources : (body.sources || registeredSources)).map((value) => String(value).trim().toLowerCase());
    const sources = requestedSources.filter((id) => registeredSources.includes(id));
    const unregisteredSources = requestedSources.filter((id) => !registeredSources.includes(id));
    const effectiveSources = sources.length ? sources : registeredSources;
    signal?.throwIfAborted();
    const sessions = [];
    for (const searchQuery of queries) {
      signal?.throwIfAborted();
      sessions.push(await search(projectId, { query: searchQuery, sources: effectiveSources,
        // Workflow policy is evaluated below, preserving unknown metadata as
        // needs-review instead of deleting those candidates before the gate.
        pageSize: Math.min(40, Math.max(1, Math.floor(Number(body.maxResults) || 12)))
      }, { signal }));
    }
    signal?.throwIfAborted();
    const searchSessionIds = sessions.map(session => session.id);
    const sourceResults = sessions.flatMap(session => session.sourceResults || []);
    const sourceFailures = [
      ...unregisteredSources.map((id) => ({ source: id, code: 'SOURCE_NOT_REGISTERED', message: `Requested source is not a registered Source Adapter. Registered sources: ${registeredSources.join(', ')}.` })),
      ...sessions.flatMap(session => session.failures)
    ];
    const rawPapers = prioritizePaperCandidates(mergeSourceCandidates(sessions.flatMap(searchSessionCandidates)), { sourcePriorities: { arxiv: 10, ...(body.sourcePriorities || {}) } });
    const policy = requestPolicy(body.policy);
    const gated = applyQualityGate(rawPapers, policy);
    const task = createStageTask({
      stage: 'search',
      input: { direction, query, requestedSources, effectiveSources, registeredSources, policy: body.policy || {} },
      output: { strategy: strategy.ok ? strategy.output : null, papers: rawPapers, searchSessionIds, evaluations: gated.results, sourceFailures },
      validation: taskValidation(strategy.validation, sourceFailures.map((failure) => `Source ${failure.source} failed or is unavailable.`)),
      harness: strategy,
      adapters: ['quality-gate', ...new Set(sourceResults.map(result => result.source))],
      error: sourceResults.length || strategy.ok ? null : new Error('All configured research sources failed.')
    });
    return updateStage(projectId, 'search', { query, queries, sources: effectiveSources, requestedSources, unregisteredSources, papers: rawPapers, searchSessionIds, evaluations: gated.results, policy: body.policy || {}, lastRunAt: new Date().toISOString(), qualitySummary: gated.summary, sourceFailures, aiSearchStrategy: strategy.ok ? strategy.output : { ok: false, validation: strategy.validation }, task }, body, actor);
  }
  if (action === 'select-papers') {
    return selectResearchPapers(projectId, { ...workflowOptions(body, actor), paperIds: body.paperIds, reviews: body.reviews });
  }
  if (action === 'generate-ideas') {
    const selectedIds = Array.isArray(body.paperIds) ? body.paperIds : [...selectedPaperIdsFrom(workflow)];
    const papers = (stageData(workflow, 'selection').selectedPapers || stageData(workflow, 'search').papers || []).filter((paper) => selectedIds.includes(String(paper.id)) || selectedIds.includes(paper.id));
    const replicationRun = await readRunHandoff(projectId, body.replicationRunId, 'replication');
    const input = { papers, direction: body.direction || stageData(workflow, 'direction'),
      ...(replicationRun ? { replicationResults: [replicationRun], paperComparison: replicationRun.paperComparison || null } : {}) };
    const harness = await runStage({ stage: 'innovation_ideas', projectId, input, humanInstructions, role: body.role, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    // No fabricated fallback: a failed Harness Run leaves the stage empty so the
    // readiness gate blocks approval. Manufacturing placeholder ideas in code
    // produced content that looked like AI output but had no Run, model, context,
    // or provenance behind it.
    const ideas = harness.ok && harness.output?.ideas ? harness.output.ideas : [];
    const task = createStageTask({ stage: 'ideation', input: { paperIds: selectedIds, direction: input.direction, ...(replicationRun ? { replicationRun } : {}) }, output: harness.ok ? harness.output : { ideas }, validation: taskValidation(harness.validation, []), harness, adapters: ['harness', 'evidence-ledger'] });
    return updateStage(projectId, 'ideation', { ideas, innovationPoints: ideas, humanDirection: harness.ok ? harness.output?.humanDirection || '' : '', comparison: harness.ok ? harness.output?.comparison || [] : [], caveats: harness.ok ? harness.output?.caveats || [] : [], harness: { ok: harness.ok, validation: harness.validation }, task }, body, actor);
  }
  if (action === 'select-ideas') {
    return selectResearchIdeas(projectId, { ...workflowOptions(body, actor), ideaIds: body.ideaIds, reviews: body.reviews });
  }
  if (action === 'generate-method') {
    const ideation = stageData(workflow, 'ideation');
    const ideas = ideation.ideas || [];
    const selected = ideas.filter((idea) => workflow.activePlanAttempt ? String(idea.id)===workflow.activePlanAttempt.ideaId : idea.selected || (body.ideaIds || []).includes(idea.id));
    const ideaPlans = selected.flatMap(idea => {
      const plan = ideation.ideaPlans?.[idea.id]?.at(-1);
      return plan ? [plan] : [];
    });
    const harness = await runStage({ stage: 'method_proposals', projectId, input: { ideas: selected, ...(ideaPlans.length ? { ideaPlans } : {}) }, humanInstructions, role: body.role, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter });
    const proposals = harness.ok && harness.output?.proposals?.length ? harness.output.proposals : [];
    const method = proposals[0] ? { ...proposals[0], title: proposals[0].name } : {};
    const task = createStageTask({ stage: 'method', input: { selectedIdeaIds: selected.map((idea) => idea.id), ...(ideaPlans.length ? { ideaPlans } : {}) }, output: { stage: harness.output, proposals }, validation: taskValidation(harness.validation, []), harness, adapters: ['harness', 'human-decision'] });
    return updateStage(projectId, 'method', { method, methodPlan: method, methodProposals: proposals, harness: { ok: harness.ok, validation: harness.validation }, task }, body, actor);
  }
  if (action === 'save-method') return updateStage(projectId, 'method', { method: body.method || {}, task: createStageTask({ stage: 'method', input: { method: body.method || {} }, output: { method: body.method || {} }, validation: { ok: true, errors: [], warnings: [] }, adapters: ['human-decision'] }) }, body, actor);
  if (action === 'run-experiment') {
    const experiment = body.experiment || {};
    const method = stageData(workflow, 'method').method || stageData(workflow, 'method');
    if (!experiment.dataset || !experiment.datasetVersion || !experiment.protocol || !experiment.execution?.entrypoint) throw new ResearchWorkflowError(400, 'EXPERIMENT_INCOMPLETE', 'Dataset, version, protocol, and a structured project entrypoint are required before an experiment can be submitted.');
    if (!method.title || !method.hypothesis || !Array.isArray(method.baselines) || !method.baselines.length || !Array.isArray(method.metrics) || !method.metrics.length) throw new ResearchWorkflowError(409, 'METHOD_PLAN_INCOMPLETE', 'Save a method title, hypothesis, baseline, and evaluation metric before submitting an experiment.');
    if (!String(experiment.methodId || '').trim() || (experiment.methodId !== method.id && experiment.methodId !== method.title)) throw new ResearchWorkflowError(409, 'METHOD_PLAN_MISMATCH', 'The experiment must identify the current saved method plan.');
    if (!(typeof experiment.seed === 'string' ? experiment.seed.trim().length > 0 : Number.isSafeInteger(experiment.seed)) || !Number.isInteger(Number(experiment.repetitions)) || Number(experiment.repetitions) < 1 || Number(experiment.repetitions) > 100 || !String(experiment.budget || '').trim() || !Array.isArray(experiment.successCriteria) || !experiment.successCriteria.length) throw new ResearchWorkflowError(400, 'EXPERIMENT_DESIGN_INCOMPLETE', 'Seed, repetitions (1-100), budget, and success criteria are required before approval.');
    return updateStage(projectId, 'experiment', { ...experiment, status: 'planned', humanApprovalRequired: true, runRequestedAt: new Date().toISOString(), task: createStageTask({ stage: 'experiment', input: { methodId: experiment.methodId, method, experiment }, output: { ...experiment, status: 'planned' }, validation: { ok: true, errors: [], warnings: ['This Experiment Plan must be converted to a structured Experiment Run, explicitly approved, and executed with the project experiment.execute capability.'] }, adapters: ['human-decision'] }) }, body, actor);
  }
  if (action === 'handoff-writing') {
    if (body.agentMode && !['single-agent', 'multi-agent'].includes(body.agentMode)) {
      throw new ResearchWorkflowError(400, 'INVALID_AGENT_MODE', 'agentMode must be single-agent or multi-agent.');
    }
    const completedWorkflow = workflow.status === 'completed';
    const selectedStage = stageData(workflow, 'selection');
    const selectedPapers = selectedStage.selectedPapers || [];
    const ideas = (stageData(workflow, 'ideation').ideas || []).filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    if(body.campaignEvaluationRunId&&!body.validationCampaignId)throw new ResearchWorkflowError(400,'WRITING_CAMPAIGN_REQUIRED','评价Run必须与明确批次一起交接。');
    if(body.validationCampaignId&&(body.experimentRunId||body.agentMode==='multi-agent'))throw new ResearchWorkflowError(400,'WRITING_CAMPAIGN_MODE_CONFLICT','完整批次不能与单实验Run混用；本片使用完整批次写作及已选择的独立评价。');
    const validationCampaign=body.validationCampaignId?await readCampaignWritingHandoff(projectId,body.validationCampaignId,body.campaignEvaluationRunId):null;
    if(validationCampaign&&(body.expectedVersion??body.version)!==undefined&&(body.expectedVersion??body.version)!==workflow.version)throw new ResearchWorkflowError(409,'VERSION_CONFLICT','流程已变化，未启动批次写作。');
    const replicationRun = await readRunHandoff(projectId, body.replicationRunId, 'replication');
    const experimentRun = await readRunHandoff(projectId, body.experimentRunId, 'experiment');
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
      experiment: validationCampaign?{kind:'validation-campaign',campaignId:validationCampaign.campaignId,status:validationCampaign.status,comparison:validationCampaign.comparison,verificationNote:validationCampaign.verificationNote}:handoffExperiment(workflow, body, experimentRun || replicationRun),
      ...(validationCampaign?{validationCampaign}:{}),
      ...(replicationRun ? { replicationRun } : {}),
      ...(experimentRun ? { experimentRun } : {}),
      evidenceLedger: citableEvidence
    };
    const harness = body.agentMode === 'multi-agent'
      ? await runWritingDelegation({ projectId, input, humanInstructions, role: body.role, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeReviewResponses: body.fakeReviewResponses, adapter: body.adapter })
      : await runStage({ stage: 'writing', projectId, input, humanInstructions, role: body.role, llmConfig: body.llmConfig, fakeResponse: body.fakeResponse, fakeError: body.fakeError, adapter: body.adapter,
        ...(validationCampaign?{runHarness:campaignWritingHarness(projectId)}:{}) });
    const task = createStageTask({ stage: 'writing', input, output: harness.output, validation: taskValidation(harness.validation), harness, adapters: ['harness', 'evidence-ledger', ...(harness.delegation ? ['multi-agent-review'] : [])], error: harness.delegation ? harness.error : null });
    if (!harness.ok || !harness.output) {
      if (completedWorkflow) {
        throw new ResearchWorkflowError(502, 'WRITING_HANDOFF_FAILED', 'SciencePrism could not refresh the writing brief.', { validation: harness.validation });
      }
      return updateStage(projectId, 'writing', { task, ready: false, harness: { ok: harness.ok, validation: harness.validation } }, body, actor);
    }
    const brief = harness.output;
    if(validationCampaign) {
      const writingData={...brief,ready:true,handoffAt:new Date().toISOString(),briefPath:'research/writing-brief.md',replicationRun,experimentRun:null,validationCampaign,
        evidence:{paperIds:selectedPapers.map(paper=>paper.id),ideas,method:input.method,experiment:input.experiment,...(replicationRun?{replicationRun}:{}),validationCampaign},task};
      const saveSources=async locked=>{
        signal?.throwIfAborted();
        await beforeCommit?.(locked);
        if(locked.version!==workflow.version)throw new ResearchWorkflowError(409,'VERSION_CONFLICT','写作期间流程已变化，旧Brief与来源未覆盖。');
        const current=await readCampaignWritingHandoff(projectId,body.validationCampaignId,body.campaignEvaluationRunId);
        if(current.sourceSha256!==validationCampaign.sourceSha256)throw new ResearchWorkflowError(409,'WRITING_CAMPAIGN_SOURCE_CHANGED','写作期间完整批次或评价来源已变化，旧Brief与来源未覆盖。');
        if(!completedWorkflow)applyStageUpdate(structuredClone(locked),{stageId:'writing',data:writingData,actor});
        for(const claim of brief.claims||[]) {
          const claimId=writingClaimEvidenceId(claim.id);
          await upsertEvidence(projectId,{id:claimId,kind:'paper-claim',title:claim.id,summary:claim.text,verificationStatus:'pending',metadata:{evidenceIds:claim.evidenceIds||[],confidence:claim.confidence},evidenceVersions:claim.evidenceVersions||{}},{actor});
          for(const evidenceId of claim.evidenceIds||[])try{await linkEvidence(projectId,{type:'supports',fromId:evidenceId,toId:claimId,actor},{actor});}catch{/* Existing claim checking remains authoritative. */}
        }
        await writeWritingBriefArtifact(projectId,brief,{replicationRun,validationCampaign});
      };
      if(completedWorkflow)return withWorkflowLock(projectId,async()=>{const current=await readWorkflowFile(await resolveProjectRoot(projectId),projectId,{readOnly:true});
        if(body.expectedVersion!==undefined&&body.expectedVersion!==current.version)throw new ResearchWorkflowError(409,'VERSION_CONFLICT','写作流程版本已变化。');
        await saveSources(current);return current;});
      return updateResearchWorkflow(projectId,{...workflowOptions(body,actor),expectedVersion:body.expectedVersion??body.version??workflow.version,stageId:'writing',data:writingData,beforeCommit:saveSources});
    }
    for (const claim of brief.claims || []) {
      const claimId = writingClaimEvidenceId(claim.id);
      await upsertEvidence(projectId, { id: claimId, kind: 'paper-claim', title: claim.id, summary: claim.text, verificationStatus: 'pending', metadata: { evidenceIds: claim.evidenceIds || [], confidence: claim.confidence }, evidenceVersions: claim.evidenceVersions || {} }, { actor });
      for (const evidenceId of claim.evidenceIds || []) {
        try { await linkEvidence(projectId, { type: 'supports', fromId: evidenceId, toId: claimId, actor }, { actor }); } catch { /* the claim check remains authoritative */ }
      }
    }
    const artifact = await writeWritingBriefArtifact(projectId, brief, { delegation: harness.delegation, replicationRun, experimentRun, validationCampaign });
    // A completed workflow is immutable, but researchers may need to refresh
    // its derived writing brief after new Evidence is verified. Save the new
    // artifact without reopening or rewriting the completed stage history.
    if (completedWorkflow) return workflow;
    return updateStage(projectId, 'writing', { ...brief, ready: true, handoffAt: new Date().toISOString(), briefPath: artifact.path, replicationRun, experimentRun, ...(validationCampaign?{validationCampaign}:{}), evidence: { paperIds: selectedPapers.map((paper) => paper.id), ideas, method: input.method, experiment: input.experiment, ...(replicationRun ? { replicationRun } : {}), ...(experimentRun ? { experimentRun } : {}), ...(validationCampaign?{validationCampaign}:{} ) }, task }, body, actor);
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
  const [catalog, bindings] = await Promise.all([listResearchSkills({ projectId, includeGeneric: true }), getResearchSkillBindings(projectId)]);
  return { skills: catalog, bindings: resolveResearchSkillBindings(bindings, catalog) };
}

export async function updateSkillsFromRequest(projectId, body, actor) {
  if (!Object.prototype.hasOwnProperty.call(body, 'bindings')) throw new ResearchWorkflowError(400, 'MISSING_SKILL_BINDINGS', 'Provide a bindings object.');
  const [catalog, currentBindings] = await Promise.all([listResearchSkills({ projectId, includeGeneric: true }), getResearchSkillBindings(projectId)]);
  let requestedBindings;
  try { requestedBindings = validateResearchSkillBindings(body.bindings, catalog); }
  catch (error) { throw new ResearchWorkflowError(400, 'INVALID_SKILL_BINDINGS', error instanceof Error ? error.message : 'Invalid skill bindings.'); }
  const workflow = await updateResearchSkillBindings(projectId, { ...workflowOptions(body, actor), bindings: { ...(currentBindings || {}), ...requestedBindings } });
  const bindings = resolveResearchSkillBindings(await getResearchSkillBindings(projectId), catalog);
  return { skills: catalog, bindings, workflow };
}

export { toFrontendWorkflow };
