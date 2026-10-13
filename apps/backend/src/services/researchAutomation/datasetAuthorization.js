import { MAX_DATASET_BYTES, SUPPORTED_DATASET_HOSTS, parseDatasetUrl } from '../datasets/download.js';
import { datasetFilename } from '../datasets/preview.js';
import { sourceHash } from './handoff.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const fail = (code, message, status = 409) => { throw new ResearchWorkflowError(status, code, message); };
function object(input, keys, code) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !keys.includes(key))) {
    fail(code, '数据授权字段无效。', 400);
  }
}
function text(value, limit, code) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.trim().length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    fail(code, '数据授权标识或文本无效。', 400);
  }
  return value.trim();
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('AUTOMATION_DATASET_VERSION_INVALID', '数据策略版本无效。', 400);
  return value;
}
function identity(value) {
  const code = 'AUTOMATION_DATASET_IDENTITY_INVALID';
  const normalized = text(value, 200, code);
  if (normalized !== value) fail(code, '数据授权标识必须完整匹配真实来源。', 400);
  return normalized;
}

export function validateDatasetScope(input) {
  if (input == null) return null;
  const code = 'AUTOMATION_DATASET_SCOPE_INVALID';
  object(input, ['allowedHosts', 'maxBytes', 'maxDatasets'], code);
  if (!Array.isArray(input.allowedHosts) || !input.allowedHosts.length
    || Array.from(input.allowedHosts).some(host => !SUPPORTED_DATASET_HOSTS.includes(host))
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_DATASET_BYTES
    || !Number.isSafeInteger(input.maxDatasets) || input.maxDatasets < 1 || input.maxDatasets > 5) {
    fail(code, '请明确配置支持的数据来源、体积和数量上限。', 400);
  }
  return { allowedHosts: [...new Set(input.allowedHosts)].sort(), maxBytes: input.maxBytes, maxDatasets: input.maxDatasets };
}

export function validateDatasetProposal(input) {
  const code = 'AUTOMATION_DATASET_PROPOSAL_INVALID';
  object(input, ['paperId', 'url', 'filename', 'license', 'split', 'expectedSha256'], code);
  const proposal = { paperId: text(input.paperId, 200, code), url: text(input.url, 4096, code), filename: text(input.filename, 240, code) };
  try { proposal.url = parseDatasetUrl(proposal.url).toString(); datasetFilename(proposal.filename); }
  catch { fail(code, '数据建议必须使用支持的公开固定来源和有效数据文件名。', 400); }
  if (input.license !== undefined) proposal.license = text(input.license, 300, code);
  proposal.split = input.split === undefined ? 'unknown' : input.split;
  if (!['unknown', 'train', 'validation', 'test'].includes(proposal.split)) fail(code, '数据划分无效。', 400);
  if (input.expectedSha256 !== undefined) {
    if (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) fail(code, '预期数据校验值无效。', 400);
    proposal.expectedSha256 = input.expectedSha256;
  }
  return proposal;
}

function context(input) {
  const code = 'AUTOMATION_DATASET_IDENTITY_INVALID';
  if (!input || typeof input !== 'object') fail(code, '需要真实研究会话和数据来源。', 400);
  const { projectId, session, stage, policyVersion, policy, proposal, sourceRunId } = input;
  const bound = { projectId: identity(projectId), sessionId: identity(session?.id),
    parentRunId: identity(session?.coordinatorRunId), stage, sourceRunId: identity(sourceRunId) };
  if (!['replication', 'experiment'].includes(stage) || (session.projectId !== undefined && session.projectId !== bound.projectId)) fail(code, '数据授权与当前研究会话不匹配。');
  if (session.status !== 'running' || session.stopRequested) fail('AUTOMATION_DATASET_INACTIVE', '研究会话已停止数据获取。');
  const mode = policy?.overrides?.dataset ?? 'inherit';
  if (!policy || typeof policy.enabled !== 'boolean' || !['inherit', 'manual', 'auto'].includes(mode)
    || !(mode === 'auto' || (mode === 'inherit' && policy.enabled))) {
    fail('AUTOMATION_DATASET_DISABLED', '当前策略未允许自动获取数据。');
  }
  const scope = validateDatasetScope(policy.datasetScope);
  if (!scope) fail('AUTOMATION_DATASET_SCOPE_REQUIRED', '自动获取数据需要明确配置来源和预算。');
  const normalized = validateDatasetProposal(proposal);
  if (!scope.allowedHosts.includes(new URL(normalized.url).hostname)) fail('AUTOMATION_DATASET_HOST_DENIED', '数据来源超出授权范围。');
  return { ...bound, policyVersion: version(policyVersion), proposal: normalized, scope };
}

export function createDatasetAuthorization(input) {
  const current = context(input);
  return { schemaVersion: 1, capability: 'dataset.acquire', actor: 'system', ...current,
    proposalSha256: sourceHash(current.proposal), scopeSha256: sourceHash(current.scope) };
}

export function assertDatasetAuthorization(auth, input) {
  object(auth, ['schemaVersion', 'capability', 'actor', 'projectId', 'sessionId', 'parentRunId', 'stage', 'sourceRunId',
    'policyVersion', 'proposal', 'proposalSha256', 'scope', 'scopeSha256'], 'AUTOMATION_DATASET_AUTHORIZATION_INVALID');
  if (auth.schemaVersion !== 1 || auth.capability !== 'dataset.acquire' || auth.actor !== 'system') {
    fail('AUTOMATION_DATASET_AUTHORIZATION_INVALID', '数据授权来源无效。');
  }
  version(auth.policyVersion);
  const current = context(input), scope = validateDatasetScope(auth.scope), proposal = validateDatasetProposal(auth.proposal);
  if (!scope || sourceHash(auth.scope) !== sourceHash(scope) || auth.scopeSha256 !== sourceHash(scope)
    || sourceHash(auth.proposal) !== sourceHash(proposal) || auth.proposalSha256 !== sourceHash(proposal)
    || auth.proposalSha256 !== sourceHash(current.proposal)) fail('AUTOMATION_DATASET_BINDING_CHANGED', '数据授权输入或快照已改变。');
  for (const key of ['projectId', 'sessionId', 'parentRunId', 'stage', 'sourceRunId']) {
    if (auth[key] !== current[key]) fail('AUTOMATION_DATASET_IDENTITY_CHANGED', '数据授权不属于当前研究来源。');
  }
  if (!scope.allowedHosts.includes(new URL(proposal.url).hostname) || scope.maxBytes > current.scope.maxBytes
    || scope.maxDatasets > current.scope.maxDatasets) fail('AUTOMATION_DATASET_SCOPE_REVOKED', '原数据授权已超出当前来源或预算范围。');
  const { paperId, ...datasetRequest } = proposal;
  return { datasetRequest: { ...datasetRequest, maxBytes: scope.maxBytes, refresh: false }, currentPolicyVersion: current.policyVersion };
}
