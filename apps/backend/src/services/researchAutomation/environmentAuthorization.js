import path from 'node:path';
import { validateEnvironmentConfiguration } from '../experimentRunner/environments.js';
import { isPathAllowed, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { sourceHash } from './handoff.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
function object(input, keys, code) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !keys.includes(key))) {
    fail(code, '环境授权字段无效。', 400);
  }
}
function identity(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value || value !== value.trim()
    || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('AUTOMATION_ENVIRONMENT_IDENTITY_INVALID', '环境授权需要完整的真实来源标识。', 400);
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('AUTOMATION_ENVIRONMENT_VERSION_INVALID', '环境策略版本无效。', 400);
  return value;
}
const budgetFields = ['maxPackages', 'maxPrepareMs', 'maxOutputBytes', 'maxEnvironments'];
export function validateEnvironmentScope(input) {
  if (input == null) return null;
  const code = 'AUTOMATION_ENVIRONMENT_SCOPE_INVALID';
  object(input, ['allowedPaths', ...budgetFields], code);
  if (!Array.isArray(input.allowedPaths) || Array.from(input.allowedPaths).some(value => typeof value !== 'string'
    || !value.isWellFormed() || !value || value !== value.trim() || value.length > 500 || /[\x00-\x1f\x7f\\*?]/.test(value)
    || value !== path.posix.normalize(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..') || isSensitivePath(value))
    || !Number.isSafeInteger(input.maxPackages) || input.maxPackages < 0 || input.maxPackages > 30
    || !Number.isSafeInteger(input.maxPrepareMs) || input.maxPrepareMs < 100 || input.maxPrepareMs > 600000
    || !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1024 || input.maxOutputBytes > 2 * 1024 * 1024
    || !Number.isSafeInteger(input.maxEnvironments) || input.maxEnvironments < 1 || input.maxEnvironments > 3) {
    fail(code, '请明确配置非敏感依赖路径、数量及环境准备预算。', 400);
  }
  return { allowedPaths: [...new Set(input.allowedPaths)].sort(), ...Object.fromEntries(budgetFields.map(key => [key, input[key]])) };
}

export function validateEnvironmentProposal(input) {
  const code = 'AUTOMATION_ENVIRONMENT_PROPOSAL_INVALID';
  object(input, ['packages'], code);
  if (!Array.isArray(input.packages)) fail(code, '环境建议必须明确列出固定依赖文件。', 400);
  try { return { packages: validateEnvironmentConfiguration(input).packages }; }
  catch { fail(code, '环境建议只能包含项目内固定 SHA256 的 wheel 文件。', 400); }
}

function allowsPackages(scope, proposal) {
  // [] is explicitly standard-library-only here; the shared project helper's
  // empty-path wildcard must never turn this task grant into unrestricted read.
  return proposal.packages.length <= scope.maxPackages && (!proposal.packages.length
    || scope.allowedPaths.length > 0 && proposal.packages.every(pkg => isPathAllowed(pkg.path, scope)));
}
function context(input) {
  if (!input || typeof input !== 'object') fail('AUTOMATION_ENVIRONMENT_IDENTITY_INVALID', '需要真实研究会话与环境建议来源。', 400);
  const { projectId, session, stage, policyVersion, policy, proposal, sourceRunId } = input;
  const bound = { projectId: identity(projectId), sessionId: identity(session?.id),
    parentRunId: identity(session?.coordinatorRunId), stage, sourceRunId: identity(sourceRunId) };
  if (!['replication', 'experiment'].includes(stage) || session.projectId !== undefined && session.projectId !== bound.projectId) {
    fail('AUTOMATION_ENVIRONMENT_IDENTITY_INVALID', '环境授权与当前研究会话不匹配。');
  }
  if (session.status !== 'running' || session.stopRequested) fail('AUTOMATION_ENVIRONMENT_INACTIVE', '研究会话已停止环境准备。');
  const mode = policy?.overrides?.environment ?? 'inherit';
  if (!policy || typeof policy.enabled !== 'boolean' || !['inherit', 'manual', 'auto'].includes(mode)
    || !(mode === 'auto' || mode === 'inherit' && policy.enabled)) fail('AUTOMATION_ENVIRONMENT_DISABLED', '当前策略未允许自动准备环境。');
  const scope = validateEnvironmentScope(policy.environmentScope);
  if (!scope) fail('AUTOMATION_ENVIRONMENT_SCOPE_REQUIRED', '自动准备环境需要明确的路径及预算授权。');
  const normalized = validateEnvironmentProposal(proposal);
  if (!allowsPackages(scope, normalized)) fail('AUTOMATION_ENVIRONMENT_PATH_DENIED', '依赖路径或数量超出环境授权范围。');
  return { ...bound, policyVersion: version(policyVersion), proposal: normalized, scope };
}

export function createEnvironmentAuthorization(input) {
  const current = context(input);
  return { schemaVersion: 1, capability: 'environment.prepare', actor: 'system', ...current,
    proposalSha256: sourceHash(current.proposal), scopeSha256: sourceHash(current.scope) };
}

export function assertEnvironmentAuthorization(auth, input) {
  object(auth, ['schemaVersion', 'capability', 'actor', 'projectId', 'sessionId', 'parentRunId', 'stage', 'sourceRunId',
    'policyVersion', 'proposal', 'proposalSha256', 'scope', 'scopeSha256'], 'AUTOMATION_ENVIRONMENT_AUTHORIZATION_INVALID');
  if (auth.schemaVersion !== 1 || auth.capability !== 'environment.prepare' || auth.actor !== 'system') {
    fail('AUTOMATION_ENVIRONMENT_AUTHORIZATION_INVALID', '环境授权来源无效。');
  }
  version(auth.policyVersion);
  const current = context(input), scope = validateEnvironmentScope(auth.scope), proposal = validateEnvironmentProposal(auth.proposal);
  if (!scope || sourceHash(auth.scope) !== sourceHash(scope) || auth.scopeSha256 !== sourceHash(scope)
    || sourceHash(auth.proposal) !== sourceHash(proposal) || auth.proposalSha256 !== sourceHash(proposal)
    || auth.proposalSha256 !== sourceHash(current.proposal)) fail('AUTOMATION_ENVIRONMENT_BINDING_CHANGED', '环境授权输入或快照已改变。');
  for (const key of ['projectId', 'sessionId', 'parentRunId', 'stage', 'sourceRunId']) {
    if (auth[key] !== current[key]) fail('AUTOMATION_ENVIRONMENT_IDENTITY_CHANGED', '环境授权不属于当前研究来源。');
  }
  if (current.policyVersion < auth.policyVersion) fail('AUTOMATION_ENVIRONMENT_VERSION_INVALID', '当前环境策略版本不能早于授权快照。');
  if (!allowsPackages(scope, proposal) || budgetFields.some(key => scope[key] > current.scope[key])
    || scope.allowedPaths.some(prefix => !current.scope.allowedPaths.length || !isPathAllowed(prefix, current.scope))) {
    fail('AUTOMATION_ENVIRONMENT_SCOPE_REVOKED', '原环境授权已超出当前路径或预算范围。');
  }
  return { environmentRequest: { ...proposal, timeoutMs: scope.maxPrepareMs, maxOutputBytes: scope.maxOutputBytes }, currentPolicyVersion: current.policyVersion };
}
