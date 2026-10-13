import { isDeepStrictEqual } from 'node:util';
import { assertCapability, assertNetworkHost, assertProjectPath } from './capabilities.js';
import { HarnessRuntimeError } from './errors.js';

const TOOLS = Object.freeze({ read_file: 'project.read', list_files: 'project.read', get_compile_log: 'project.read',
  read_research_skill: 'project.read', propose_patch: 'patch.propose', apply_patch: 'patch.propose',
  arxiv_search: 'research.search', arxiv_bibtex: 'research.search' });
const fail = (code, message, status = 403) => new HarnessRuntimeError(status, code, message);
const bounded = (value, limit = 200) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
function capabilities(value, defaults = false) {
  const result = {};
  for (const key of ['granted', 'allowedPaths', 'networkAllowlist']) {
    const entries = defaults && key !== 'granted' && value?.[key] === undefined ? [] : value?.[key];
    if (!Array.isArray(entries) || entries.length > 2000 || entries.some(entry => !bounded(entry, 4096))) {
      throw fail('LEGACY_POLICY_UNAVAILABLE', 'The current tool capability scope is invalid.');
    }
    result[key] = Object.freeze([...entries]);
  }
  return Object.freeze(result);
}
function snapshot(value) {
  if (!value || !['projectId', 'runId', 'role', 'task'].every(key => bounded(value[key])) || typeof value.active !== 'boolean'
    || !['auto', 'manual'].includes(value.mode)
    || !(bounded(value.version) || typeof value.version === 'number' && Number.isFinite(value.version))) {
    throw fail('LEGACY_POLICY_UNAVAILABLE', 'The current Run tool policy is invalid.');
  }
  return Object.freeze({ ...Object.fromEntries(['projectId', 'runId', 'role', 'task', 'active', 'mode', 'version'].map(key => [key, value[key]])),
    capabilities: capabilities(value.capabilities) });
}
async function readSnapshot(readPolicy) {
  try { return snapshot(await readPolicy()); }
  catch (reason) {
    if (reason instanceof HarnessRuntimeError) throw reason;
    throw fail('LEGACY_POLICY_UNAVAILABLE', 'The current Run tool policy could not be read.');
  }
}
function checkedPath(value, tool) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value && value.split('/').some(part => !part || part === '.' || part === '..')
    || !value && tool !== 'list_files') throw fail('PATH_DENIED', 'A normalized relative tool path is required.');
  return value;
}
function effectiveCapabilities(scopes) {
  let allowedPaths = [], disjoint = false;
  for (const scope of scopes) {
    const next = scope.allowedPaths;
    next.forEach(value => checkedPath(value, 'read_file'));
    const combined = !allowedPaths.length ? next : !next.length ? allowedPaths
      : [...new Set(allowedPaths.flatMap(a => next.flatMap(b => a === b || a.startsWith(`${b}/`) ? [a] : b.startsWith(`${a}/`) ? [b] : [])))];
    disjoint ||= allowedPaths.length > 0 && next.length > 0 && combined.length === 0;
    allowedPaths = combined;
  }
  return { granted: scopes[0].granted.filter(value => scopes.every(scope => scope.granted.includes(value))
    && !(disjoint && ['project.read', 'patch.propose'].includes(value))), allowedPaths,
  networkAllowlist: scopes[0].networkAllowlist.filter(host => scopes.every(scope => scope.networkAllowlist.includes(host))) };
}

/** The existing Legacy executor owns operations. This admission only binds its
 * trusted effect hooks to the current Run policy and durable tool decisions. */
export async function createLegacyToolPolicy({ projectId, task, capabilityPolicy, readPolicy, onDecision, signal } = {}) {
  if (typeof readPolicy !== 'function' || typeof onDecision !== 'function'
    || projectId !== undefined && !bounded(projectId) || task !== undefined && !bounded(task)) {
    throw fail('LEGACY_POLICY_UNAVAILABLE', 'A current Run policy and persisted tool decisions are required.');
  }
  const fixed = capabilities(capabilityPolicy, true), ceiling = await readSnapshot(readPolicy);
  if (projectId !== undefined && ceiling.projectId !== projectId || task !== undefined && ceiling.task !== task) {
    throw fail('LEGACY_OWNER_CHANGED', 'The tool policy does not belong to its trusted project and task.');
  }
  const check = (policy, admitted) => {
    if (signal?.aborted) throw fail('LEGACY_CANCELLED', 'The Legacy tool operation was cancelled.');
    if (!ceiling.active || !policy.active) throw fail('LEGACY_RUN_INACTIVE', 'The owning Run is inactive.');
    if (['projectId', 'runId', 'role', 'task'].some(key => policy[key] !== ceiling[key])) throw fail('LEGACY_OWNER_CHANGED', 'The tool operation no longer belongs to its bound Run and role.');
    if (admitted && (policy.version !== admitted.version || policy.mode !== admitted.mode
      || !isDeepStrictEqual(policy.capabilities, admitted.capabilities))) throw fail('LEGACY_POLICY_CHANGED', 'The Run tool policy changed; a fresh admission is required.');
  };
  return Object.freeze({
    async admit(input) {
      let policy = ceiling;
      const validIdentity = input && typeof input === 'object' && !Array.isArray(input) && bounded(input.callId);
      const tool = validIdentity && bounded(input.tool) ? input.tool : '';
      const capability = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : null;
      const decision = (value, reasonCode) => onDecision({ type: 'tool/policy', tool, callId: input.callId,
        projectId: ceiling.projectId, runId: ceiling.runId, actor: 'system', capability,
        policyVersion: policy.version, decision: value, ...(reasonCode ? { reasonCode } : {}) });
      const deny = async reason => {
        const reasonCode = bounded(reason?.code, 100) ? reason.code : 'LEGACY_TOOL_FAILED';
        try { await decision('deny', reasonCode); }
        catch { throw fail('LEGACY_AUDIT_UNAVAILABLE', 'The tool policy decision could not be persisted.'); }
      };
      try {
        if (!validIdentity || !bounded(input.tool) || Object.keys(input).some(key => !['tool', 'callId', 'path'].includes(key))) throw fail('LEGACY_ARGUMENTS_INVALID', 'A bounded tool call identity is required.', 400);
        if (!capability) throw fail('LEGACY_TOOL_NOT_BOUND', 'This Legacy tool is not bound to the Run.');
        if (['read_file', 'propose_patch', 'apply_patch'].includes(tool) && input.path === undefined) throw fail('PATH_DENIED', 'File tools require a normalized relative path.');
        if (input.path !== undefined) checkedPath(input.path, tool);
        const current = async (admitted, effects = {}) => {
          if (!effects || typeof effects !== 'object' || Array.isArray(effects) || Object.keys(effects).some(key => !['path', 'url'].includes(key))) throw fail('LEGACY_ARGUMENTS_INVALID', 'Only trusted path and network effects can be rechecked.', 400);
          policy = await readSnapshot(readPolicy); check(policy, admitted);
          const effective = effectiveCapabilities([fixed, ceiling.capabilities, policy.capabilities]);
          assertCapability(effective, capability);
          for (const scope of [fixed, ceiling.capabilities, policy.capabilities]) {
            assertCapability(scope, capability);
            for (const target of new Set([input.path, effects.path].filter(value => value !== undefined))) {
              checkedPath(target, tool); assertProjectPath(target, scope, { operation: capability === 'patch.propose' ? 'patch' : 'read' });
            }
            if (effects.url !== undefined) {
              if (capability !== 'research.search') throw fail('NETWORK_DENIED', 'This tool has no network effect authority.');
              if (typeof effects.url !== 'string' || !bounded(effects.url, 8192)) throw fail('NETWORK_DENIED', 'A bounded trusted network URL is required.');
              assertNetworkHost(scope, effects.url);
            }
          }
          return structuredClone(effective);
        };
        await current(); const admitted = policy;
        try { await decision('allow'); }
        catch { throw fail('LEGACY_AUDIT_UNAVAILABLE', 'The tool policy decision could not be persisted.'); }
        await current(admitted);
        return Object.freeze({ recheck: (effects = {}) => current(admitted, effects), deny });
      } catch (reason) {
        if (validIdentity) { try { await deny(reason); } catch {} }
        throw reason;
      }
    }
  });
}
