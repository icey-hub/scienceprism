import {
  approveResearchWorkflow,
  getResearchWorkflow,
  getResearchSkillBindings,
  initializeResearchWorkflow,
  ResearchWorkflowError,
  resetResearchWorkflow,
  updateResearchSkillBindings,
  updateResearchWorkflow
} from '../services/researchWorkflow/index.js';
import { XMLParser } from 'fast-xml-parser';
import {
  applyQualityGate,
  normalizeQualityPolicy,
  runResearchStage,
  listResearchSkills,
  resolveResearchSkillBindings,
  validateResearchSkillBindings
} from '../services/researchResearch/index.js';
import { getEnv } from '../config/constants.js';

const BASE_PATH = '/api/projects/:id/research-workflow';

const UI_TO_STAGE = Object.freeze({
  direction: 'direction',
  search: 'search',
  selection: 'selection',
  replication: 'replication',
  innovation: 'ideation',
  method: 'method',
  experiment: 'experiment',
  writing: 'writing'
});

const STAGE_TO_UI = Object.fromEntries(Object.entries(UI_TO_STAGE).map(([key, value]) => [value, key]));

function stageData(workflow, id) {
  return workflow?.stages?.find((stage) => stage.id === id)?.data || {};
}

function uiStageState(stage, currentStage) {
  if (stage.status === 'approved' || stage.status === 'skipped') return 'complete';
  if (stage.status === 'rejected') return 'error';
  if (stage.id === currentStage) return 'active';
  const order = workflowStageOrder(stage.id);
  const currentOrder = workflowStageOrder(currentStage);
  return order === currentOrder + 1 ? 'ready' : 'locked';
}

function workflowStageOrder(stageId) {
  const order = ['direction', 'search', 'selection', 'replication', 'ideation', 'method', 'experiment', 'writing'];
  return order.indexOf(stageId);
}

function paperForUi(paper, selectionIds = new Set()) {
  const candidate = paper?.candidate || paper || {};
  const decision = paper?.decision || paper?.eligibility;
  return {
    id: candidate.id || paper.id,
    title: candidate.title || paper.title || 'Untitled paper',
    venue: candidate.venue || paper.venue || '',
    year: candidate.year || paper.year || 0,
    authors: candidate.authors || paper.authors || [],
    abstract: candidate.abstract || paper.abstract || '',
    url: candidate.url || paper.url || '',
    ccf: candidate.venueLevel || paper.ccf || '',
    quality: paper.qualityScore ?? paper.quality ?? null,
    selected: selectionIds.has(candidate.id || paper.id),
    eligibility: decision === 'accept' || decision === 'pass' ? 'pass' : decision === 'reject' ? 'reject' : 'review',
    reason: paper.reasons?.join(' ') || paper.reason || ''
  };
}

function toUiWorkflow(workflow) {
  const direction = stageData(workflow, 'direction');
  const search = stageData(workflow, 'search');
  const selection = stageData(workflow, 'selection');
  const replication = stageData(workflow, 'replication');
  const ideation = stageData(workflow, 'ideation');
  const method = stageData(workflow, 'method');
  const experiment = stageData(workflow, 'experiment');
  const writing = stageData(workflow, 'writing');
  const selectedIds = new Set(selection.selectedPaperIds || selection.paperIds || []);
  const rawPapers = search.evaluations || search.results || search.papers || [];
  const papers = rawPapers.map((paper) => paperForUi(paper, selectedIds));
  const ideas = ideation.ideas || ideation.innovationPoints || [];
  const currentStage = STAGE_TO_UI[workflow.currentStage] || workflow.currentStage;
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    version: workflow.version,
    status: workflow.status,
    activeStage: currentStage,
    currentStage,
    stages: (workflow.stages || []).map((stage) => ({
      id: STAGE_TO_UI[stage.id] || stage.id,
      state: uiStageState(stage, workflow.currentStage),
      status: stage.status,
      updatedAt: stage.updatedAt
    })),
    direction: {
      question: direction.researchQuestion || direction.topic || direction.question || '',
      keywords: direction.seedKeywords || direction.keywords || [],
      scope: direction.scope || '',
      notes: direction.notes || ''
    },
    search: {
      query: search.query || search.queries?.[0] || '',
      count: papers.length,
      lastRunAt: search.lastRunAt || null,
      policy: search.policy || null
    },
    papers,
    replication: replication.replication || replication.replicationPlan || replication,
    ideas: ideas.map((idea, index) => ({
      id: idea.id || `idea-${index + 1}`,
      title: idea.title || idea.name || `候选创新点 ${index + 1}`,
      summary: idea.summary || idea.problem || idea.description || '',
      evidence: idea.evidence || idea.relatedPaperIds || [],
      selected: Boolean(idea.selected)
    })),
    method: {
      title: method.title || method.name || '',
      hypothesis: method.hypothesis || method.description || '',
      baselines: method.baselines || [],
      ablations: method.ablations || []
    },
    experiment: {
      dataset: experiment.dataset || experiment.datasetId || experiment.datasetIds?.join(', ') || '',
      command: experiment.command || experiment.commands?.join('\n') || '',
      status: experiment.status || '待规划',
      metrics: experiment.metrics || []
    },
    writing: {
      ready: Boolean(writing.ready || writing.handoffAt),
      handoffAt: writing.handoffAt || null,
      outline: writing.outline || writing.evidence?.outline || '',
      evidence: writing.evidence || null
    },
    policy: search.policy || selection.policy || null,
    audit: workflow.audit || [],
    updatedAt: workflow.updatedAt
  };
}

function uiStageId(value) {
  return UI_TO_STAGE[value] || value;
}

async function searchArxiv(query, maxResults = 12) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${Math.min(20, Math.max(1, Number(maxResults) || 12))}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'scienceprism/1.0' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`arXiv search failed: ${response.status}`);
  const xml = await response.text();
  const data = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : data?.feed?.entry ? [data.feed.entry] : [];
  return entries.map((entry) => {
    const authors = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
    const id = String(entry.id || '');
    return {
      id: id.split('/').pop() || id,
      title: String(entry.title || '').replace(/\s+/g, ' ').trim(),
      abstract: String(entry.summary || '').replace(/\s+/g, ' ').trim(),
      authors: authors.map((author) => author?.name).filter(Boolean),
      year: entry.published ? Number(String(entry.published).slice(0, 4)) : null,
      url: id,
      source: 'arXiv',
      publicationType: 'preprint',
      peerReviewed: null
    };
  });
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

function actorFromRequest(req, body = {}) {
  return body.actor || req.headers?.['x-scienceprism-actor'] || req.headers?.['x-openprism-actor'] || req.collabAuth?.sub || 'human';
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function sendError(req, reply, error) {
  if (error instanceof ResearchWorkflowError) {
    return reply.code(error.statusCode).send({
      ok: false,
      workflow: null,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    });
  }
  req.log?.error?.(error);
  return reply.code(500).send({ ok: false, workflow: null, error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
}

function route(handler) {
  return async (req, reply) => {
    try {
      const workflow = await handler(req, reply);
      return reply.send({ ok: true, workflow: toUiWorkflow(workflow) });
    } catch (error) {
      return sendError(req, reply, error);
    }
  };
}

function actionRoute(handler) {
  return async (req, reply) => {
    try {
      const workflow = await handler(req);
      return reply.send({ ok: true, workflow: toUiWorkflow(workflow) });
    } catch (error) {
      return sendError(req, reply, error);
    }
  };
}

async function updateStage(projectId, stageId, data, req) {
  return updateResearchWorkflow(projectId, {
    stageId,
    data,
    actor: actorFromRequest(req, bodyOf(req)),
    note: bodyOf(req).note
  });
}

function selectedPaperIdsFrom(workflow) {
  const data = stageData(workflow, 'selection');
  return new Set(data.selectedPaperIds || data.paperIds || []);
}

async function handleUiAction(req, body) {
  const projectId = req.params.id;
  const action = body.action;
  if (action === 'search') {
    const direction = body.direction || {};
    const query = String(body.query || direction.question || '').trim();
    if (!query) throw new ResearchWorkflowError(400, 'MISSING_QUERY', 'A search query or research question is required.');
    const strategy = await runResearchStage({
      stage: 'search_strategy',
      projectId,
      input: { researchQuestion: direction.question || query, humanDirection: direction, seedQuery: query },
      humanInstructions: body.humanInstructions,
      llmConfig: body.llmConfig
    });
    const queries = strategy.ok && strategy.output?.queries?.length
      ? [...new Set([query, ...strategy.output.queries.map(String)])].slice(0, 4)
      : [query];
    const searchBatches = await Promise.all(queries.map((item) => searchArxiv(item, body.maxResults)));
    const rawPapers = [...new Map(searchBatches.flat().map((paper) => [paper.id, paper])).values()];
    const policy = requestPolicy(body.policy);
    const gated = applyQualityGate(rawPapers, policy);
    return updateStage(projectId, 'search', {
      query, queries, papers: rawPapers, evaluations: gated.results,
      policy: body.policy || {}, lastRunAt: new Date().toISOString(), qualitySummary: gated.summary,
      aiSearchStrategy: strategy.ok ? strategy.output : { ok: false, validation: strategy.validation }
    }, req);
  }
  if (action === 'select-papers') {
    const workflow = await getResearchWorkflow(projectId);
    const evaluations = stageData(workflow, 'search').evaluations || [];
    const requested = Array.isArray(body.paperIds) ? body.paperIds.map(String) : [];
    const accepted = new Set(evaluations.filter((item) => item.decision === 'accept').map((item) => String(item.id)));
    const blocked = requested.filter((id) => !accepted.has(id));
    if (blocked.length) throw new ResearchWorkflowError(409, 'QUALITY_GATE', 'Only papers accepted by the server-side quality gate can be selected.', { blockedPaperIds: blocked });
    return updateStage(projectId, 'selection', {
      selectedPaperIds: requested,
      selectedPapers: evaluations.filter((item) => requested.includes(String(item.id))).map((item) => item.candidate),
      policy: stageData(workflow, 'search').policy || {}
    }, req);
  }
  if (action === 'generate-ideas') {
    const workflow = await getResearchWorkflow(projectId);
    const selectedIds = Array.isArray(body.paperIds) ? body.paperIds : [...selectedPaperIdsFrom(workflow)];
    const papers = (stageData(workflow, 'selection').selectedPapers || stageData(workflow, 'search').papers || [])
      .filter((paper) => selectedIds.includes(String(paper.id)) || selectedIds.includes(paper.id));
    const harness = await runResearchStage({ stage: 'innovation_ideas', projectId, input: { papers, direction: body.direction || stageData(workflow, 'direction') }, humanInstructions: body.humanInstructions, llmConfig: body.llmConfig });
    const ideas = harness.ok && harness.output?.ideas ? harness.output.ideas : papers.slice(0, 3).map((paper, index) => ({
      id: `paper-gap-${index + 1}`, title: `围绕“${paper.title || '候选论文'}”的可检验扩展`, summary: '需要人工补充明确的研究缺口。',
      problem: '需要人工补充明确的研究缺口。', motivation: '当前内容仅作草稿。', hypothesis: '', novelty: '',
      relatedPaperIds: [paper.id].filter(Boolean), validationPlan: [], risks: ['Harness 未返回结构化创新点。'], selected: false
    }));
    return updateStage(projectId, 'ideation', { ideas, innovationPoints: ideas, harness: { ok: harness.ok, validation: harness.validation } }, req);
  }
  if (action === 'select-ideas') {
    const workflow = await getResearchWorkflow(projectId);
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const ids = new Set((Array.isArray(body.ideaIds) ? body.ideaIds : []).map(String));
    return updateStage(projectId, 'ideation', { ideas: ideas.map((idea) => ({ ...idea, selected: ids.has(String(idea.id)) })) }, req);
  }
  if (action === 'generate-method') {
    const workflow = await getResearchWorkflow(projectId);
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const selected = ideas.filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    const harness = await runResearchStage({ stage: 'method_proposals', projectId, input: { ideas: selected }, humanInstructions: body.humanInstructions, llmConfig: body.llmConfig });
    const method = harness.ok && harness.output?.proposals?.[0]
      ? { ...harness.output.proposals[0], title: harness.output.proposals[0].name }
      : { title: '', hypothesis: '', baselines: [], ablations: [], harness: { ok: harness.ok, validation: harness.validation } };
    return updateStage(projectId, 'method', { method, methodPlan: method, harness: { ok: harness.ok, validation: harness.validation } }, req);
  }
  if (action === 'save-method') return updateStage(projectId, 'method', { method: body.method || {} }, req);
  if (action === 'run-experiment') {
    const experiment = body.experiment || {};
    if (!experiment.dataset || !experiment.command) throw new ResearchWorkflowError(400, 'EXPERIMENT_INCOMPLETE', 'Dataset and command are required before an experiment can run.');
    return updateStage(projectId, 'experiment', { ...experiment, status: 'planned', humanApprovalRequired: true, runRequestedAt: new Date().toISOString() }, req);
  }
  if (action === 'handoff-writing') {
    return updateStage(projectId, 'writing', { ready: true, handoffAt: new Date().toISOString(), evidence: { paperIds: body.paperIds || [], ideas: body.ideas || [], method: body.method || {}, experiment: body.experiment || {} } }, req);
  }
  throw new ResearchWorkflowError(400, 'UNKNOWN_ACTION', `Unknown research workflow action: ${action}`);
}

export function registerResearchWorkflowRoutes(fastify) {
  fastify.get(`${BASE_PATH}/skills`, async (req, reply) => {
    try {
      const [catalog, bindings] = await Promise.all([
        listResearchSkills({ projectId: req.params.id }),
        getResearchSkillBindings(req.params.id)
      ]);
      return reply.send({
        ok: true,
        skills: catalog,
        bindings: resolveResearchSkillBindings(bindings, catalog)
      });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  fastify.put(`${BASE_PATH}/skills/bindings`, async (req, reply) => {
    try {
      const body = bodyOf(req);
      if (!Object.prototype.hasOwnProperty.call(body, 'bindings')) {
        throw new ResearchWorkflowError(400, 'MISSING_SKILL_BINDINGS', 'Provide a bindings object.');
      }
      const [catalog, currentBindings] = await Promise.all([
        listResearchSkills({ projectId: req.params.id }),
        getResearchSkillBindings(req.params.id)
      ]);
      let requestedBindings;
      try {
        requestedBindings = validateResearchSkillBindings(body.bindings, catalog);
      } catch (error) {
        throw new ResearchWorkflowError(400, 'INVALID_SKILL_BINDINGS', error instanceof Error ? error.message : 'Invalid skill bindings.');
      }
      const workflow = await updateResearchSkillBindings(req.params.id, {
        bindings: { ...(currentBindings || {}), ...requestedBindings },
        actor: actorFromRequest(req, body),
        note: body.note
      });
      const bindings = resolveResearchSkillBindings(
        await getResearchSkillBindings(req.params.id),
        catalog
      );
      return reply.send({ ok: true, skills: catalog, bindings, workflow: toUiWorkflow(workflow) });
    } catch (error) {
      return sendError(req, reply, error);
    }
  });

  fastify.get(BASE_PATH, route(async (req) => {
    return getResearchWorkflow(req.params?.id);
  }));

  fastify.post(BASE_PATH, route(async (req, reply) => {
    const body = bodyOf(req);
    if (body.action) return handleUiAction(req, body);
    const workflow = await initializeResearchWorkflow(req.params?.id, {
      data: body.data || body.initialData || {},
      actor: actorFromRequest(req, body)
    });
    reply.code(201);
    return workflow;
  }));

  fastify.patch(BASE_PATH, route(async (req) => {
    const body = bodyOf(req);
    if (body.direction) {
      return updateStage(req.params.id, 'direction', {
        topic: body.direction.question || '',
        researchQuestion: body.direction.question || '',
        seedKeywords: body.direction.keywords || [],
        scope: body.direction.scope || '',
        notes: body.direction.notes || ''
      }, req);
    }
    return updateResearchWorkflow(req.params?.id, {
      stageId: uiStageId(body.stageId || body.stage),
      data: body.data,
      patch: body.patch,
      status: body.status,
      note: body.note,
      actor: actorFromRequest(req, body)
    });
  }));

  fastify.post(`${BASE_PATH}/approve`, route(async (req) => {
    const body = bodyOf(req);
    const stageId = uiStageId(body.stageId || body.stage);
    const workflow = await approveResearchWorkflow(req.params?.id, {
      stageId,
      decision: body.decision || 'approve',
      note: body.note,
      actor: actorFromRequest(req, body)
    });
    // The compact UI treats reproduction as optional. When it is not shown,
    // record the skip explicitly before exposing the next user-facing stage.
    if (stageId === 'selection' && workflow.currentStage === 'replication' && !body.keepReplication) {
      return approveResearchWorkflow(req.params?.id, {
        stageId: 'replication',
        decision: 'skip',
        note: '研究工作台默认跳过可选复现阶段。',
        actor: actorFromRequest(req, body)
      });
    }
    return workflow;
  }));

  fastify.post(`${BASE_PATH}/reset`, route(async (req) => {
    const body = bodyOf(req);
    return resetResearchWorkflow(req.params?.id, {
      note: body.note,
      actor: actorFromRequest(req, body)
    });
  }));

  // User-facing action aliases. They keep the UI language simple while all
  // writes still pass through the same current-stage gate and audit log.
  fastify.put(`${BASE_PATH}/direction`, actionRoute(async (req) => {
    const body = bodyOf(req);
    return updateStage(req.params.id, 'direction', {
      topic: body.question || body.topic || '',
      researchQuestion: body.question || body.researchQuestion || body.topic || '',
      seedKeywords: Array.isArray(body.keywords) ? body.keywords : [],
      scope: body.scope || '',
      notes: body.notes || ''
    }, req);
  }));

  fastify.post(`${BASE_PATH}/search`, actionRoute(async (req) => {
    const body = bodyOf(req);
    const direction = body.direction || {};
    const query = String(body.query || direction.question || '').trim();
    if (!query) throw new ResearchWorkflowError(400, 'MISSING_QUERY', 'A search query or research question is required.');
    const rawPapers = await searchArxiv(query, body.maxResults);
    const policy = requestPolicy(body.policy);
    const gated = applyQualityGate(rawPapers, policy);
    return updateStage(req.params.id, 'search', {
      query,
      queries: [query],
      papers: rawPapers,
      evaluations: gated.results,
      policy: body.policy || {},
      lastRunAt: new Date().toISOString(),
      qualitySummary: gated.summary
    }, req);
  }));

  fastify.post(`${BASE_PATH}/papers/select`, actionRoute(async (req) => {
    const body = bodyOf(req);
    const workflow = await getResearchWorkflow(req.params.id);
    const evaluations = stageData(workflow, 'search').evaluations || [];
    const requested = Array.isArray(body.paperIds) ? body.paperIds.map(String) : [];
    const accepted = new Set(evaluations.filter((item) => item.decision === 'accept').map((item) => String(item.id)));
    const blocked = requested.filter((id) => !accepted.has(id));
    if (blocked.length) {
      throw new ResearchWorkflowError(409, 'QUALITY_GATE', 'Only papers accepted by the server-side quality gate can be selected.', {
        blockedPaperIds: blocked
      });
    }
    return updateStage(req.params.id, 'selection', {
      selectedPaperIds: requested,
      selectedPapers: evaluations.filter((item) => requested.includes(String(item.id))).map((item) => item.candidate),
      policy: stageData(workflow, 'search').policy || {}
    }, req);
  }));

  fastify.post(`${BASE_PATH}/replication/skip`, actionRoute(async (req) => {
    const body = bodyOf(req);
    return approveResearchWorkflow(req.params.id, {
      stageId: 'replication',
      decision: 'skip',
      note: body.note,
      actor: actorFromRequest(req, body)
    });
  }));

  fastify.post(`${BASE_PATH}/ideas/generate`, actionRoute(async (req) => {
    const body = bodyOf(req);
    const workflow = await getResearchWorkflow(req.params.id);
    const selectedIds = Array.isArray(body.paperIds) ? body.paperIds : [...selectedPaperIdsFrom(workflow)];
    const papers = (stageData(workflow, 'selection').selectedPapers || stageData(workflow, 'search').papers || [])
      .filter((paper) => selectedIds.includes(String(paper.id)) || selectedIds.includes(paper.id));
    let ideas = [];
    const harness = await runResearchStage({
      stage: 'innovation_ideas',
      projectId: req.params.id,
      input: { papers, direction: body.direction || stageData(workflow, 'direction') },
      humanInstructions: body.humanInstructions,
      llmConfig: body.llmConfig
    });
    if (harness.ok && harness.output?.ideas) {
      ideas = harness.output.ideas;
    } else {
      ideas = papers.slice(0, 3).map((paper, index) => ({
        id: `paper-gap-${index + 1}`,
        title: `围绕“${paper.title || '候选论文'}”的可检验扩展`,
        problem: '需要人工补充明确的研究缺口。',
        motivation: '由入选论文生成的起点，不代表已验证创新。',
        hypothesis: '',
        novelty: '',
        relatedPaperIds: [paper.id].filter(Boolean),
        validationPlan: [],
        risks: ['Harness 未返回结构化创新点，当前内容仅作草稿。'],
        selected: false
      }));
    }
    return updateStage(req.params.id, 'ideation', { ideas, innovationPoints: ideas, harness: { ok: harness.ok, validation: harness.validation } }, req);
  }));

  fastify.post(`${BASE_PATH}/ideas/select`, actionRoute(async (req) => {
    const body = bodyOf(req);
    const workflow = await getResearchWorkflow(req.params.id);
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const ids = new Set((Array.isArray(body.ideaIds) ? body.ideaIds : []).map(String));
    return updateStage(req.params.id, 'ideation', { ideas: ideas.map((idea) => ({ ...idea, selected: ids.has(String(idea.id)) })) }, req);
  }));

  fastify.post(`${BASE_PATH}/method/generate`, actionRoute(async (req) => {
    const body = bodyOf(req);
    const workflow = await getResearchWorkflow(req.params.id);
    const ideas = stageData(workflow, 'ideation').ideas || [];
    const selected = ideas.filter((idea) => idea.selected || (body.ideaIds || []).includes(idea.id));
    const harness = await runResearchStage({
      stage: 'method_proposals',
      projectId: req.params.id,
      input: { ideas: selected },
      humanInstructions: body.humanInstructions,
      llmConfig: body.llmConfig
    });
    const method = harness.ok && harness.output?.proposals?.[0]
      ? { ...harness.output.proposals[0], title: harness.output.proposals[0].name }
      : { title: '', hypothesis: '', baselines: [], ablations: [], harness: { ok: harness.ok, validation: harness.validation } };
    return updateStage(req.params.id, 'method', { method, methodPlan: method, harness: { ok: harness.ok, validation: harness.validation } }, req);
  }));

  fastify.post(`${BASE_PATH}/experiments/run`, actionRoute(async (req) => {
    const body = bodyOf(req);
    const experiment = body.experiment || {};
    if (!experiment.dataset || !experiment.command) {
      throw new ResearchWorkflowError(400, 'EXPERIMENT_INCOMPLETE', 'Dataset and command are required before an experiment can run.');
    }
    // The first release records a human-approved run plan. Actual process
    // execution is intentionally delegated to a later sandboxed runner.
    return updateStage(req.params.id, 'experiment', {
      ...experiment,
      status: 'planned',
      humanApprovalRequired: true,
      runRequestedAt: new Date().toISOString()
    }, req);
  }));

  fastify.post(`${BASE_PATH}/writing/handoff`, actionRoute(async (req) => {
    const body = bodyOf(req);
    return updateStage(req.params.id, 'writing', {
      ready: true,
      handoffAt: new Date().toISOString(),
      evidence: {
        paperIds: body.paperIds || [],
        ideas: body.ideas || [],
        method: body.method || {},
        experiment: body.experiment || {}
      }
    }, req);
  }));
}
