import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveProjectRoot, withWorkflowLock } from '../researchWorkflow/repository.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { RESEARCH_WORKFLOW_STAGES } from '../researchWorkflow/stageContracts.js';
import { mutateWorkflow } from '../researchWorkflow/commands.js';
import { applyApprovalDecision } from '../researchWorkflow/stateMachine.js';
import { applyPaperSelection } from '../researchWorkflow/paperSelection.js';
import { appendAudit } from '../researchWorkflow/audit.js';
import { inspectAutomationOwner } from './owner.js';
import { validateDatasetScope } from './datasetAuthorization.js';
import { validateEnvironmentScope } from './environmentAuthorization.js';

export const AUTOMATION_PARTS = [...RESEARCH_WORKFLOW_STAGES.map(stage => stage.id), 'dataset', 'environment', 'execution', 'patches'];
const FILE = '.scienceprism/research-automation.json';
const modes = ['inherit', 'auto', 'manual'];
const invalid = message => { throw new ResearchWorkflowError(400, 'INVALID_AUTOMATION_POLICY', message); };
const executionPlanSchema = z.object({
  dataset: z.string().trim().min(1).max(500), datasetVersion: z.string().trim().min(1).max(500), protocol: z.string().trim().min(1).max(4000),
  execution: z.object({ adapter: z.enum(['node','python']), entrypoint: z.string().min(1).max(500), args: z.array(z.string().max(2000)).max(30).default([]), environmentId:z.string().regex(/^environment-[a-f0-9-]{36}$/).optional() }).strict(),
  seed: z.union([z.string().max(100),z.number().int()]).default(0), successCriteria: z.array(z.string().max(2000)).min(1).max(30),
  artifacts: z.array(z.object({ path: z.string().min(1).max(500), kind: z.enum(['metric','output','chart','table','checkpoint','log']), name: z.string().max(200).optional() }).strict()).max(30).default([]),
  parameters: z.record(z.unknown()).optional(), codePaths: z.array(z.string().max(500)).max(100).optional(),
  resources: z.object({timeoutMs:z.number().int().positive(),maxOutputBytes:z.number().int().positive().optional(),maxArtifactBytes:z.number().int().positive().optional()}).strict().optional()
}).strict();
export function validateAutomationExecution(value) {
  if (value === undefined || value === null) return null;
  const result = executionPlanSchema.safeParse(value);
  if (!result.success) throw new ResearchWorkflowError(400, 'INVALID_AUTOMATION_EXECUTION', '实验材料只能包含代码入口、数据、版本及运行参数。');
  return result.data;
}

export function validateAutomationPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'overrides', 'agentMode', 'datasetScope', 'environmentScope'].includes(key))) invalid('策略包含未知字段。');
  if (typeof value.enabled !== 'boolean' || !['specialists', 'generalist'].includes(value.agentMode)) invalid('请提供自动研究开关和Agent模式。');
  if (!value.overrides || typeof value.overrides !== 'object' || Array.isArray(value.overrides)) invalid('环节策略必须为对象。');
  for (const [part, mode] of Object.entries(value.overrides)) if (!AUTOMATION_PARTS.includes(part) || !modes.includes(mode)) invalid('未知环节或确认模式。');
  return { enabled: value.enabled, agentMode: value.agentMode, overrides: { ...value.overrides }, ...(value.datasetScope !== undefined ? { datasetScope: validateDatasetScope(value.datasetScope) } : {}), ...(value.environmentScope !== undefined ? { environmentScope: validateEnvironmentScope(value.environmentScope) } : {}) };
}

export function allowsAutomatic(policy, part) {
  const mode = policy.overrides[part] || 'inherit';
  return mode === 'auto' || (mode === 'inherit' && policy.enabled);
}

export async function readAutomation(projectId) {
  const root = await resolveProjectRoot(projectId);
  try {
    const state = JSON.parse(await fs.readFile(path.join(root, FILE), 'utf8'));
    if (state.schemaVersion !== 1 || !Number.isInteger(state.version)) throw new Error('Invalid automation document');
    validateAutomationPolicy(state.policy);
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ResearchWorkflowError(500, 'AUTOMATION_CORRUPT', '自动研究配置损坏，请保留文件并检查。');
    return { schemaVersion: 1, version: 1, policy: { enabled: false, overrides: {}, agentMode: 'specialists' }, session: null, audit: [] };
  }
}

export async function mutateAutomation(projectId, mutate) {
  return withWorkflowLock(projectId, async () => {
    const root = await resolveProjectRoot(projectId);
    const owner = inspectAutomationOwner({ projectRoot: root });
    if (owner && !owner.released && owner.present !== false && owner.pid !== process.pid) throw new ResearchWorkflowError(409, 'AUTOMATION_OWNER_BUSY', '另一个后端仍持有该项目的研究链路。');
    const state = await readAutomation(projectId);
    await mutate(state);
    const target = path.join(root, FILE);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n'); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
    return structuredClone(state);
  });
}

export async function saveAutomationPolicy(projectId, { actor, expectedVersion, policy }) {
  if (actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', '自动授权策略由用户设置。');
  const validated = validateAutomationPolicy(policy);
  return mutateAutomation(projectId, state => {
    if (expectedVersion !== state.version) throw new ResearchWorkflowError(409, 'VERSION_CONFLICT', '自动策略已变化，请重新读取。');
    state.version += 1;
    state.policy = validated;
    state.audit = [...state.audit, { at: new Date().toISOString(), actor, version: state.version, policy: validated }].slice(-100);
  });
}

// Called again inside the authoritative workflow/Run mutation, after async work.
export async function requireAutomatic(projectId, part, sessionId) {
  const state = await readAutomation(projectId);
  if (!allowsAutomatic(state.policy, part)) throw new ResearchWorkflowError(409, 'AUTOMATION_CONFIRMATION_REQUIRED', '该环节需要人工确认。', { part });
  if (sessionId && (state.session?.id !== sessionId || state.session.status !== 'running' || state.session.stopRequested)) throw new ResearchWorkflowError(409, 'AUTOMATION_STOPPED', '自动链路已停止或被替换。');
  return { actor: 'system', policyVersion: state.version, sessionId: sessionId || null, part };
}

export function automaticWorkflowDecision(projectId, { sessionId, stageId, expectedVersion, paperIds, decision = 'approve', note }) {
  return mutateWorkflow(projectId, {
    command: 'automatic-decision', expectedVersion,
    idempotencyKey: `${sessionId}:${stageId}:${paperIds ? 'selection' : decision}`,
    payload: { sessionId, stageId, paperIds, decision },
    mutate: async workflow => {
      const authorization = await requireAutomatic(projectId, stageId, sessionId);
      if (workflow.id !== (await readAutomation(projectId)).session.workflowId) throw new ResearchWorkflowError(409, 'AUTOMATION_WORKFLOW_CHANGED', '研究流程已重置。');
      const options = { stageId, actor: 'system', note: note || `自动研究授权（策略v${authorization.policyVersion}）` };
      if (paperIds) await applyPaperSelection(projectId, workflow, { ...options, paperIds, automatic: true });
      else applyApprovalDecision(workflow, { ...options, decision });
      const stage = workflow.stages.find(stage => stage.id === stageId);
      stage.automaticDecision = authorization;
      appendAudit(workflow, 'automation.decision', { stageId, actor: 'system', details: { ...authorization, decision: paperIds ? 'select-papers' : decision } });
      return workflow;
    }
  });
}
