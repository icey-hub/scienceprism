import { ResearchWorkflowError, assertExpectedVersion, assertPlainObject, sanitizeNote, sanitizeHumanInstructions } from './errors.js';
import { appendAudit, clone } from './audit.js';
import { applyApprovalDecision, applyRecovery, applyReset, applyStageUpdate, createWorkflowDocument } from './stateMachine.js';
import { normalizeSkillBindings } from './skillBindings.js';
import { readWorkflowFile, resolveProjectRoot, withWorkflowLock, writeWorkflowFile } from './repository.js';
import { assertStageId } from './stageContracts.js';
import { applyPaperSelection } from './paperSelection.js';
import { createStageTask } from './stageTask.js';

function commandKey(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const key = String(value).trim();
  if (!key || key.length > 200) throw new ResearchWorkflowError(400, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be between 1 and 200 characters.');
  return key;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function fingerprint(command, payload) {
  return JSON.stringify(stableValue({ command, payload }));
}

function receiptFor(workflow, key, expectedFingerprint) {
  if (!key) return null;
  const receipt = workflow.commandReceipts?.[key];
  if (!receipt) return null;
  if (receipt.fingerprint !== expectedFingerprint) throw new ResearchWorkflowError(409, 'IDEMPOTENCY_KEY_REUSED', 'idempotencyKey was already used for a different command.');
  return clone(workflow);
}

function rememberReceipt(workflow, key, expectedFingerprint, command) {
  if (!key) return;
  workflow.commandReceipts = workflow.commandReceipts || {};
  workflow.commandReceipts[key] = { command, fingerprint: expectedFingerprint, version: workflow.version, recordedAt: workflow.updatedAt };
  const keys = Object.keys(workflow.commandReceipts);
  if (keys.length > 100) delete workflow.commandReceipts[keys[0]];
}

async function mutateWorkflow(projectId, { command, actor, note, expectedVersion, idempotencyKey, payload = {}, mutate }) {
  const root = await resolveProjectRoot(projectId);
  const key = commandKey(idempotencyKey);
  const expectedFingerprint = fingerprint(command, payload);
  return withWorkflowLock(projectId, async () => {
    const workflow = await readWorkflowFile(root, projectId);
    const replay = receiptFor(workflow, key, expectedFingerprint);
    if (replay) return replay;
    const version = assertExpectedVersion(expectedVersion);
    if (version !== undefined && version !== workflow.version) {
      throw new ResearchWorkflowError(409, 'VERSION_CONFLICT', 'Research workflow changed since it was read.', { expectedVersion: version, actualVersion: workflow.version });
    }
    const next = await mutate(workflow);
    rememberReceipt(next, key, expectedFingerprint, command);
    await writeWorkflowFile(root, next);
    return next;
  });
}

export async function initializeResearchWorkflow(projectId, { data = {}, actor, idempotencyKey } = {}) {
  const root = await resolveProjectRoot(projectId);
  const initialData = assertPlainObject(data);
  const key = commandKey(idempotencyKey);
  const expectedFingerprint = fingerprint('initialize', { data: initialData });
  return withWorkflowLock(projectId, async () => {
    try {
      const existing = await readWorkflowFile(root, projectId);
      const replay = receiptFor(existing, key, expectedFingerprint);
      if (replay) return replay;
      throw new ResearchWorkflowError(409, 'WORKFLOW_EXISTS', 'Research workflow already exists.');
    } catch (error) {
      if (error instanceof ResearchWorkflowError && error.code !== 'WORKFLOW_NOT_FOUND') throw error;
    }
    const workflow = createWorkflowDocument(projectId, { data: initialData, actor });
    rememberReceipt(workflow, key, expectedFingerprint, 'initialize');
    await writeWorkflowFile(root, workflow);
    return workflow;
  });
}

export function selectResearchPapers(projectId, options = {}) {
  if (options.actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', 'Only a human may save paper selection.');
  return mutateWorkflow(projectId, {
    command: 'select-papers', actor: options.actor, note: options.note,
    expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { paperIds: options.paperIds, reviews: options.reviews, note: options.note },
    mutate: (workflow) => applyPaperSelection(projectId, workflow, options)
  });
}

// reviews is optional for legacy selection clients; only explicit human input may set it.
export function selectResearchIdeas(projectId, { ideaIds = [], reviews, ...options } = {}) {
  if (reviews !== undefined && options.actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', 'Only a human may save innovation reviews.');
  return mutateWorkflow(projectId, {
    command: 'select-ideas', ...options, payload: { ideaIds, reviews, note: options.note },
    mutate: (workflow) => {
      const previous = workflow.stages.find(stage => stage.id === 'ideation').data;
      const ideas = previous.ideas || [];
      const candidates = new Map(ideas.map(idea => [String(idea.id), idea]));
      if (!Array.isArray(ideaIds) || ideaIds.some(id => typeof id !== 'string' || !candidates.has(id)) || new Set(ideaIds).size !== ideaIds.length) {
        throw new ResearchWorkflowError(400, 'INVALID_IDEA_SELECTION', 'ideaIds must name unique existing candidates.');
      }
      const invalidReview = () => { throw new ResearchWorkflowError(400, 'INVALID_IDEA_REVIEW', 'Each review must name a unique candidate and a falsificationCondition string of at most 2000 characters.'); };
      if (reviews !== undefined && (!Array.isArray(reviews) || reviews.length > candidates.size)) invalidReview();
      const explicit = new Map();
      for (const review of reviews || []) {
        if (!review || typeof review !== 'object' || Array.isArray(review) || Object.keys(review).some(key => !['ideaId', 'falsificationCondition'].includes(key)) || !candidates.has(review.ideaId) || explicit.has(review.ideaId) || typeof review.falsificationCondition !== 'string' || review.falsificationCondition.length > 2000) invalidReview();
        explicit.set(review.ideaId, review.falsificationCondition.trim());
      }
      const history = [...(previous.reviewHistory || [])];
      const selected = new Set(ideaIds);
      const now = new Date().toISOString();
      const nextIdeas = ideas.map(idea => {
        let humanReview = idea.humanReview;
        const condition = explicit.get(String(idea.id));
        if (condition !== undefined && condition !== humanReview?.falsificationCondition) {
          humanReview = { falsificationCondition: condition, actor: 'human', at: now, workflowVersion: workflow.version };
          const { humanReview: priorReview, ...candidate } = idea;
          history.push({ ideaId: String(idea.id), ...humanReview, candidate: clone(candidate) });
        }
        return { ...idea, ...(humanReview ? { humanReview } : {}), selected: selected.has(String(idea.id)) };
      });
      return applyStageUpdate(workflow, {
        ...options, stageId: 'ideation', data: {
          ideas: nextIdeas, reviewHistory: history,
          task: createStageTask({ stage: 'ideation', input: { candidateIds: [...candidates.keys()], reviews: reviews || [] }, output: { selectedIdeaIds: ideaIds },
            validation: { ok: selected.size > 0, errors: selected.size ? [] : [{ code: 'NO_IDEAS_SELECTED', path: 'ideaIds', message: 'Select an innovation candidate before approval.' }], warnings: [] }, adapters: ['human-decision'] })
        }
      });
    }
  });
}

export function saveResearchDirection(projectId, { direction, ...options } = {}) {
  assertPlainObject(direction);
  const condition = direction.falsificationCondition;
  if (condition !== undefined && (typeof condition !== 'string' || condition.length > 2000)) {
    throw new ResearchWorkflowError(400, 'INVALID_FALSIFICATION_CONDITION', 'falsificationCondition must be a string of at most 2000 characters.');
  }
  const data = {
    topic: direction.question || '', researchQuestion: direction.question || '',
    seedKeywords: direction.keywords || [], scope: direction.scope || '', notes: direction.notes || '',
    ...(condition !== undefined ? { falsificationCondition: condition.trim() } : {})
  };
  return mutateWorkflow(projectId, {
    command: 'save-direction', ...options, payload: { direction, note: options.note },
    mutate: (workflow) => applyStageUpdate(workflow, {
      ...options, stageId: 'direction', data: {
        ...data,
        task: createStageTask({ stage: 'direction', input: { direction }, output: data,
          validation: { ok: Boolean(data.researchQuestion.trim()), errors: data.researchQuestion.trim() ? [] : [{ code: 'MISSING_RESEARCH_QUESTION', path: 'researchQuestion', message: 'A research question is required.' }], warnings: [] }, adapters: ['human-input'] })
      }
    })
  });
}

export function updateResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: 'update', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { stageId: options.stageId, data: options.data, patch: options.patch, status: options.status },
    mutate: (workflow) => applyStageUpdate(workflow, options)
  });
}

export function updateResearchHumanInstructions(projectId, { stageId, humanInstructions, actor, expectedVersion, idempotencyKey } = {}) {
  assertStageId(stageId);
  if (actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', 'Only a human may save research suggestions.');
  const text = sanitizeHumanInstructions(humanInstructions);
  return mutateWorkflow(projectId, {
    command: 'update-human-instructions', actor, expectedVersion, idempotencyKey,
    payload: { stageId, humanInstructions: text },
    mutate: (workflow) => {
      workflow.humanInstructions = { ...(workflow.humanInstructions || {}), [stageId]: text };
      appendAudit(workflow, 'stage.human-instructions.updated', { stageId, actor, details: { hasInstructions: Boolean(text) } });
      return workflow;
    }
  });
}

export function approveResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: options.decision || 'approve', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { stageId: options.stageId, decision: options.decision || 'approve', note: options.note },
    mutate: (workflow) => applyApprovalDecision(workflow, options)
  });
}

export function rejectResearchWorkflow(projectId, options = {}) { return approveResearchWorkflow(projectId, { ...options, decision: 'reject' }); }
export function skipResearchWorkflow(projectId, options = {}) { return approveResearchWorkflow(projectId, { ...options, decision: 'skip' }); }

export function recoverResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: 'recover', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { note: options.note }, mutate: (workflow) => applyRecovery(workflow, options)
  });
}

export function resetResearchWorkflow(projectId, options = {}) {
  return mutateWorkflow(projectId, {
    command: 'reset', actor: options.actor, note: options.note, expectedVersion: options.expectedVersion, idempotencyKey: options.idempotencyKey,
    payload: { note: options.note }, mutate: (workflow) => applyReset(workflow, options)
  });
}

export function updateResearchSkillBindings(projectId, { bindings, actor, note, expectedVersion, idempotencyKey } = {}) {
  const normalizedBindings = normalizeSkillBindings(bindings);
  return mutateWorkflow(projectId, {
    command: 'update-skills', actor, note, expectedVersion, idempotencyKey, payload: { bindings: normalizedBindings },
    mutate: (workflow) => {
      if (workflow.status === 'completed') throw new ResearchWorkflowError(409, 'WORKFLOW_COMPLETED', 'Completed research workflows cannot be changed.');
      workflow.skillBindings = normalizedBindings;
      appendAudit(workflow, 'workflow.skills.updated', {
        actor, note: sanitizeNote(note), details: { stages: Object.keys(normalizedBindings), skillCount: Object.values(normalizedBindings).reduce((count, skillNames) => count + skillNames.length, 0) }
      });
      return workflow;
    }
  });
}

export { commandKey, fingerprint };
