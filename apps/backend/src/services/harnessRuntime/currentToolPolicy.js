import { createHash } from 'node:crypto';
import path from 'node:path';
import { applyProjectConstraintPolicy, resolveCapabilityPolicy, DEFAULT_PROJECT_CAPABILITIES, isSensitivePath } from './capabilities.js';
import { resolveRoleCapabilities } from '../agentRoles/index.js';
import { HarnessRuntimeError } from './errors.js';
import { readAutomation } from '../researchAutomation/policy.js';
import { assertCodeProducerRequest } from '../researchAutomation/codeAuthorization.js';
import { sourceHash } from '../researchAutomation/handoff.js';

function scope(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(part => !part || part === '..' || part === '.') || path.posix.isAbsolute(value) || isSensitivePath(value))) {
    throw new HarnessRuntimeError(403, 'TOOL_POLICY_INVALID', 'Project tool path scope is invalid.');
  }
  return [...new Set(values)];
}
export function intersectPaths(left, right) {
  if (!left.length) return right;
  if (!right.length) return left;
  return [...new Set(left.flatMap(a => right.flatMap(b => a === b || a.startsWith(`${b}/`) ? [a] : b.startsWith(`${a}/`) ? [b] : [])))];
}

/** The owning Run and project constraints are re-read for each broker check.
 * The initial Run is only a ceiling: changing configuration never expands an
 * in-flight Run. Stage/manual approval is separate from bounded read/proposal
 * tools already authorized when the user started this Run.
 */
export function createCurrentToolPolicy({ initialRun, getRun, readConstraints, signal, readCodeState = projectId => readAutomation(projectId) }) {
  return async () => {
    const current = await getRun();
    const constraints = await readConstraints();
    const configured = applyProjectConstraintPolicy(resolveCapabilityPolicy({ requested: current.capabilities.granted,
      configured: constraints.capabilities ?? DEFAULT_PROJECT_CAPABILITIES }), constraints);
    let granted = configured.granted.filter(value => initialRun.capabilities.granted.includes(value));
    if (current.role) granted = resolveRoleCapabilities(current.role, { granted }).granted;
    const initialPaths = scope(initialRun.capabilities.allowedPaths || []);
    const storedPaths = scope(current.capabilities.allowedPaths || []);
    const currentPaths = scope(constraints.allowedPaths ?? constraints.fileScope ?? []);
    let paths = intersectPaths(initialPaths, storedPaths);
    let disjoint = initialPaths.length && storedPaths.length && !paths.length;
    const combined = intersectPaths(paths, currentPaths);
    disjoint ||= paths.length && currentPaths.length && !combined.length;
    paths = combined;
    if (disjoint) granted = granted.filter(value => !['project.read', 'patch.propose'].includes(value));
    const networkAllowlist = (initialRun.capabilities.networkAllowlist || []).filter(host => configured.networkAllowlist.includes(host) && (current.capabilities.networkAllowlist || []).includes(host));
    let patchPaths;
    const authorization = initialRun.request?.context?.codeAuthorization;
    if (authorization || current.request?.context?.codeAuthorization) {
      if (!authorization || current.kind !== 'research-stage' || initialRun.kind !== 'research-stage'
        || current.projectId !== authorization.projectId || current.automationSessionId !== authorization.sessionId
        || current.role !== initialRun.role || current.id !== initialRun.id
        || sourceHash(current.request?.context?.codeAuthorization) !== sourceHash(authorization)) {
        throw new HarnessRuntimeError(403, 'AUTOMATION_CODE_PRODUCER_CHANGED', 'The running code producer no longer belongs to its admitted grant.');
      }
      const admitted = assertCodeProducerRequest({ state: await readCodeState(current.projectId), request: current.request,
        parentRunId: current.parentRunId, runId: current.id });
      patchPaths = scope(admitted.allowedPaths);
      if (!patchPaths.length || sourceHash(initialRun.capabilities.patchPaths) !== sourceHash(patchPaths)
        || sourceHash(current.capabilities.patchPaths) !== sourceHash(patchPaths)) {
        throw new HarnessRuntimeError(403, 'AUTOMATION_CODE_PRODUCER_CHANGED', 'The fixed code proposal scope changed.');
      }
    }
    const policy = { projectId: current.projectId, runId: current.id, role: current.role || 'unassigned', task: current.task,
      active: !signal.aborted && current.status === 'running' && current.attempt === initialRun.attempt,
      mode: 'auto', capabilities: { granted, allowedPaths: paths, networkAllowlist, ...(patchPaths ? { patchPaths } : {}) } };
    const version = createHash('sha256').update(JSON.stringify({ ...policy, attempt: current.attempt })).digest('hex');
    return { ...policy, version };
  };
}
