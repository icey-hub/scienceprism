import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../projectService.js';
import { getClaimEvidenceMatrix } from '../evidenceLedger/index.js';
import { getPendingResearchApprovals, getResearchWorkflow, toFrontendWorkflow } from '../researchWorkflow/index.js';
import { initializeResearchWorkflow } from '../researchWorkflow/index.js';
import { listHarnessRuns } from '../harnessRuntime/index.js';
import { applyProjectConstraintPolicy, DEFAULT_PROJECT_CAPABILITIES } from '../harnessRuntime/capabilities.js';
import { getPaperLibrarySummary } from './paperLibrary.js';
import { getTaskSummary } from './taskCenter.js';
import { readHubJson, writeHubJson } from './repository.js';

const CONSTRAINT_FILE = 'project-constraints.json';
const DEFAULT_CONSTRAINTS = Object.freeze({
  capabilities: [...DEFAULT_PROJECT_CAPABILITIES],
  allowedPaths: [],
  networkAllowlist: [],
  maxTokens: 49152,
  timeoutMs: 600000,
  maxConcurrent: 1,
  retryLimit: 1,
  contextTokenBudget: 12000,
  fallback: true
});

function now() { return new Date().toISOString(); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

async function readProjectMeta(projectId) {
  const root = await getProjectRoot(projectId);
  return JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
}

async function writeProjectMeta(projectId, patch) {
  const root = await getProjectRoot(projectId);
  const filePath = path.join(root, 'project.json');
  const meta = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const next = { ...meta, ...patch, updatedAt: now() };
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export async function getProjectConstraints(projectId) {
  const value = await readHubJson(projectId, CONSTRAINT_FILE, () => DEFAULT_CONSTRAINTS);
  return {
    ...DEFAULT_CONSTRAINTS,
    ...value,
    capabilities: Array.isArray(value?.capabilities) ? value.capabilities : DEFAULT_CONSTRAINTS.capabilities,
    allowedPaths: Array.isArray(value?.allowedPaths) ? value.allowedPaths : [],
    networkAllowlist: Array.isArray(value?.networkAllowlist) ? value.networkAllowlist : []
  };
}

export async function initializeProject(projectId, input = {}, actor = 'human') {
  const meta = await readProjectMeta(projectId);
  const question = text(input.researchQuestion || input.question || input.topic);
  if (!question) throw new Error('Research question is required.');
  const existingConstraints = await getProjectConstraints(projectId);
  const constraints = {
    ...DEFAULT_CONSTRAINTS,
    ...existingConstraints,
    ...(input.constraints || {}),
    capabilities: Array.isArray(input.constraints?.capabilities) ? input.constraints.capabilities : existingConstraints.capabilities,
    allowedPaths: Array.isArray(input.constraints?.allowedPaths) ? input.constraints.allowedPaths : existingConstraints.allowedPaths,
    networkAllowlist: Array.isArray(input.constraints?.networkAllowlist) ? input.constraints.networkAllowlist : existingConstraints.networkAllowlist
  };
  const policy = applyProjectConstraintPolicy({ granted: constraints.capabilities }, constraints);
  constraints.capabilities = policy.granted;
  await writeHubJson(projectId, CONSTRAINT_FILE, constraints);
  let workflow;
  try {
    workflow = await getResearchWorkflow(projectId);
  } catch (error) {
    if (error?.code !== 'WORKFLOW_NOT_FOUND') throw error;
    workflow = await initializeResearchWorkflow(projectId, {
      data: {
        researchQuestion: question,
        topic: question,
        keywords: Array.isArray(input.keywords) ? input.keywords : [],
        scope: text(input.scope),
        notes: text(input.notes),
        model: text(input.model)
      },
      actor
    });
  }
  const nextMeta = await writeProjectMeta(projectId, {
    researchQuestion: question,
    researchScope: text(input.scope),
    researchKeywords: Array.isArray(input.keywords) ? input.keywords : [],
    model: text(input.model),
    setupCompletedAt: meta.setupCompletedAt || now()
  });
  return { project: nextMeta, workflow, constraints };
}

function risk(id, severity, title, detail, href) {
  return { id, severity, title, detail, href: href || null };
}

export async function getProjectDashboard(projectId) {
  const project = await readProjectMeta(projectId);
  const constraints = await getProjectConstraints(projectId);
  const library = await getPaperLibrarySummary(projectId);
  const tasks = await getTaskSummary(projectId);
  let workflow = null;
  let frontendWorkflow = null;
  let approvals = [];
  let matrix = { ok: true, totalClaims: 0, supportedClaims: 0, unsupportedClaims: 0, needsVerificationClaims: 0, rows: [], missingEvidenceIds: [], unverifiedEvidenceIds: [], staleEvidenceIds: [] };
  try {
    workflow = await getResearchWorkflow(projectId);
    frontendWorkflow = toFrontendWorkflow(workflow);
    approvals = await getPendingResearchApprovals(projectId);
    matrix = await getClaimEvidenceMatrix(projectId);
  } catch (error) {
    if (error?.code !== 'WORKFLOW_NOT_FOUND') throw error;
  }
  const runs = await listHarnessRuns(projectId, { limit: 8 }).catch(() => []);
  const stages = workflow?.stages || [];
  const completeStages = stages.filter((stage) => ['approved', 'skipped'].includes(stage.status)).length;
  const current = stages.find((stage) => stage.id === workflow?.currentStage);
  const risks = [];
  if (!workflow) risks.push(risk('setup', 'action', '项目尚未初始化', '填写研究问题、模型和约束后才能开始第一阶段。', `/project/${projectId}`));
  if (approvals.length) risks.push(risk('approval', 'action', `${approvals.length} 项研究阶段等待确认`, 'AI 输出和结构校验已经完成，下一步仍需要人工决定。', `/project/${projectId}`));
  if (tasks.failed) risks.push(risk('tasks', 'error', `${tasks.failed} 个任务失败`, '查看任务日志，确认原因后重试或修正输入。', `/project/${projectId}/tasks`));
  if (matrix.unsupportedClaims || matrix.needsVerificationClaims) risks.push(risk('claims', 'warning', '写作主张仍有证据缺口', `${matrix.unsupportedClaims} 条主张缺少证据，${matrix.needsVerificationClaims} 条主张需要验证。`, `/project/${projectId}/quality`));
  if (library.needsSourceReview) risks.push(risk('sources', 'warning', `${library.needsSourceReview} 篇论文需要来源检查`, '资料库中的元数据尚未完成来源检查。', `/project/${projectId}/library`));
  const nextAction = !workflow
    ? { label: '完成项目初始化', href: `/project/${projectId}`, reason: '设置研究问题、模型和 Harness 约束' }
    : approvals.length
      ? { label: `确认${approvals[0].label}`, href: `/editor/${projectId}/research/${approvals[0].stageId === 'ideation' ? 'innovation' : approvals[0].stageId}`, reason: '阶段已满足自动校验，等待人工审批' }
      : { label: current ? `继续${current.label}` : '打开研究流程', href: `/editor/${projectId}/research/${current?.id === 'ideation' ? 'innovation' : current?.id || 'direction'}`, reason: current?.status === 'rejected' ? '处理上一次驳回' : '从当前阶段继续' };
  return {
    project,
    initialized: Boolean(workflow && project.setupCompletedAt),
    constraints,
    workflow: frontendWorkflow,
    progress: { completed: completeStages, total: stages.length || 8, percent: stages.length ? Math.round((completeStages / stages.length) * 100) : 0, currentStage: workflow?.currentStage || null, currentStatus: current?.status || null },
    approvals,
    risks,
    nextAction,
    recentRuns: runs,
    tasks,
    library,
    quality: matrix,
    model: project.model || null,
    currentStage: current ? { id: current.id, label: current.label, status: current.status, updatedAt: current.updatedAt } : null,
    generatedAt: now()
  };
}

export { CONSTRAINT_FILE, DEFAULT_CONSTRAINTS };

