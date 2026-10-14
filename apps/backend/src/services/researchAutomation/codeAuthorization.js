import path from 'node:path';
import { isPathAllowed, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { sourceHash } from './handoff.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
const budgets = ['maxTokens', 'timeoutMs', 'maxVersions'];
function object(value, keys, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) {
    fail(code, '代码授权字段无效。', 400);
  }
}
function identity(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value || value !== value.trim()
    || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('AUTOMATION_CODE_IDENTITY_INVALID', '代码授权需要完整的真实来源标识。', 400);
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('AUTOMATION_CODE_VERSION_INVALID', '代码策略版本无效。', 400);
  return value;
}
function inputHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('AUTOMATION_CODE_INPUT_INVALID', '代码准备必须绑定固定材料摘要。', 400);
  return value;
}

export function validateCodeScope(value) {
  if (value == null) return null;
  const code = 'AUTOMATION_CODE_SCOPE_INVALID';
  object(value, ['allowedPaths', ...budgets], code);
  if (!Array.isArray(value.allowedPaths) || !value.allowedPaths.length || Array.from(value.allowedPaths).some(prefix => typeof prefix !== 'string'
    || !prefix.isWellFormed() || !prefix || prefix !== prefix.trim() || prefix.length > 500 || /[\x00-\x1f\x7f\\:*?]/.test(prefix)
    || prefix !== path.posix.normalize(prefix) || prefix.startsWith('/') || prefix.split('/').some(part => !part || part.startsWith('.'))
    || isSensitivePath(prefix))
    || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 128 || value.maxTokens > 1_000_000
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 600000
    || !Number.isSafeInteger(value.maxVersions) || value.maxVersions < 1 || value.maxVersions > 2) {
    fail(code, '请明确配置非敏感源码路径、模型预算、时限和代码版本上限。', 400);
  }
  return { allowedPaths: [...new Set(value.allowedPaths)].sort(), ...Object.fromEntries(budgets.map(key => [key, value[key]])) };
}

function context(value) {
  if (!value || typeof value !== 'object') fail('AUTOMATION_CODE_IDENTITY_INVALID', '需要真实研究会话和代码材料。', 400);
  const { projectId, session, stage, policyVersion, policy, inputSha256 } = value;
  const bound = { projectId: identity(projectId), sessionId: identity(session?.id), parentRunId: identity(session?.coordinatorRunId), stage };
  if (!['replication', 'experiment'].includes(stage) || session.projectId !== undefined && session.projectId !== projectId) {
    fail('AUTOMATION_CODE_IDENTITY_INVALID', '代码授权与当前研究会话不匹配。');
  }
  if (session.status !== 'running' || session.stopRequested) fail('AUTOMATION_CODE_INACTIVE', '研究会话已停止代码准备。');
  const mode = policy?.overrides?.code ?? 'inherit';
  if (!policy || typeof policy.enabled !== 'boolean' || !['inherit', 'auto', 'manual'].includes(mode)
    || !(mode === 'auto' || mode === 'inherit' && policy.enabled)) fail('AUTOMATION_CODE_DISABLED', '当前策略未允许自动准备代码。');
  const scope = validateCodeScope(policy.codeScope);
  if (!scope) fail('AUTOMATION_CODE_SCOPE_REQUIRED', '自动准备代码需要明确的源码路径和预算授权。');
  return { ...bound, inputSha256: inputHash(inputSha256), policyVersion: version(policyVersion), scope };
}

export function createCodeAuthorization(input) {
  const current = context(input);
  return { schemaVersion: 1, capability: 'patch.propose', actor: 'system', ...current, scopeSha256: sourceHash(current.scope) };
}

export function assertCodeAuthorization(auth, input) {
  object(auth, ['schemaVersion', 'capability', 'actor', 'projectId', 'sessionId', 'parentRunId', 'stage',
    'inputSha256', 'policyVersion', 'scope', 'scopeSha256'], 'AUTOMATION_CODE_AUTHORIZATION_INVALID');
  if (auth.schemaVersion !== 1 || auth.capability !== 'patch.propose' || auth.actor !== 'system') {
    fail('AUTOMATION_CODE_AUTHORIZATION_INVALID', '代码授权来源无效。');
  }
  version(auth.policyVersion);
  const current = context(input), scope = validateCodeScope(auth.scope);
  if (!scope || sourceHash(auth.scope) !== sourceHash(scope) || auth.scopeSha256 !== sourceHash(scope)
    || inputHash(auth.inputSha256) !== current.inputSha256) fail('AUTOMATION_CODE_BINDING_CHANGED', '代码授权的材料或范围摘要已改变。');
  for (const key of ['projectId', 'sessionId', 'parentRunId', 'stage']) {
    if (auth[key] !== current[key]) fail('AUTOMATION_CODE_IDENTITY_CHANGED', '代码授权不属于当前研究来源。');
  }
  if (current.policyVersion < auth.policyVersion) fail('AUTOMATION_CODE_VERSION_INVALID', '当前代码策略版本不能早于授权快照。');
  if (budgets.some(key => scope[key] > current.scope[key]) || scope.allowedPaths.some(prefix => !isPathAllowed(prefix, current.scope))) {
    fail('AUTOMATION_CODE_SCOPE_REVOKED', '原代码授权已超出当前源码路径或预算范围。');
  }
  return scope;
}

/** Admission for a real stage producer; a grant is persisted before Run creation.
 * Only a calls-linked running Run may use it for tools. No execution permission. */
export function assertCodeProducerRequest({ state, request, parentRunId, parentScope, runId }) {
  const auth = request?.context?.codeAuthorization;
  if (!auth || request.role !== 'experiment-code-producer' || !['research:code-preparation', 'research:code-repair'].includes(request.task)
    || request.context?.automationHandoff?.sessionId !== state.session?.id || parentRunId !== state.session?.coordinatorRunId
    || state.session?.currentStage !== request.stage) {
    fail('AUTOMATION_CODE_PRODUCER_INVALID', '代码准备必须由原研究父任务派发并保留授权。');
  }
  const scope = assertCodeAuthorization(auth, { projectId: auth.projectId, session: state.session, stage: request.stage,
    inputSha256: sourceHash(request.input), policyVersion: state.version, policy: state.policy });
  const step = state.session.steps?.find(item => item.stage === request.stage);
  const entry = step?.codePreparations?.find(item => sourceHash(item.authorization) === sourceHash(auth));
  if (!entry || step.codePreparations.length > scope.maxVersions
    || runId && (!step.calls?.some(call => call.runId === runId && call.task === request.task) || entry.producerRunId !== runId)) {
    fail('AUTOMATION_CODE_PRODUCER_CHANGED', '代码准备授权或真实调用归属已改变。');
  }
  if (parentScope !== undefined) {
    const ceiling = validateCodeScope(parentScope);
    if (!ceiling || budgets.some(key => scope[key] > ceiling[key]) || scope.allowedPaths.some(prefix => !isPathAllowed(prefix, ceiling))) {
      fail('AUTOMATION_CODE_PARENT_SCOPE_DENIED', '代码授权超出研究父任务创建时的上限；旧父任务不能追授。');
    }
  }
  const limits = request.limits;
  if (!limits || !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 128 || limits.maxTokens > scope.maxTokens
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 100 || limits.timeoutMs > scope.timeoutMs
    || limits.retryLimit !== 0 || limits.maxConcurrent !== 1 || request.fallback !== false) {
    fail('AUTOMATION_CODE_LIMIT_DENIED', '代码准备必须使用原授权内的有限预算，禁止额外自动重派。');
  }
  return scope;
}
