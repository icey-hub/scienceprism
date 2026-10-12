import { HARNESS_CAPABILITIES } from './capabilities.js';

const deny = (code, reason) => ({ kind: 'deny', reason, info: { code } });
const unavailable = () => deny('DSH_POLICY_UNAVAILABLE', 'The project tool policy is unavailable.');
const isPromise = value => value && typeof value.then === 'function';

/**
 * Install inside the DSH SDK profile, before accepting session/prompt.
 *
 * readPolicy(execution) is synchronous and returns the CURRENT owning Run:
 * { projectId, runId, version, role, task, active, mode: 'auto'|'manual',
 *   capabilities: { granted: string[] } }.
 *
 * Each trusted binding is { name, capability, roles, tasks, check }.
 * check(execution, policy) MUST synchronously return true after validating the
 * exact schema, arguments, paths/hosts and current binding. It must not perform
 * the tool's side effect. No name matching, default tools or grants are added.
 *
 * Optional requestApproval({ execution, policy, signal }) returns
 * { decision: 'approve'|'reject'|'cancel', actor: 'human', policyVersion }.
 * Automatic mode uses the already-authorized project policy, without prompting.
 * Neither this bridge nor a prompt replaces command/filesystem isolation.
 */
export function installDshPolicyBridge(ctx, { readPolicy, bindings, requestApproval, onDecision } = {}) {
  if (typeof ctx?.tools?.guard !== 'function' || typeof ctx?.on !== 'function' || typeof readPolicy !== 'function') {
    throw new TypeError('DSH requires tools.guard, tools/pre-execute and a synchronous project policy reader.');
  }
  if (!Array.isArray(bindings)) throw new TypeError('Explicit DSH tool bindings are required.');
  const tools = new Map();
  for (const binding of bindings) {
    if (typeof binding?.name !== 'string' || !binding.name || tools.has(binding.name) || !HARNESS_CAPABILITIES.includes(binding.capability)
      || !Array.isArray(binding.roles) || !binding.roles.length || !Array.isArray(binding.tasks) || !binding.tasks.length
      || typeof binding.check !== 'function') throw new TypeError('Each DSH tool needs one explicit capability, role/task binding and argument check.');
    tools.set(binding.name, Object.freeze({ ...binding, roles: Object.freeze([...binding.roles]), tasks: Object.freeze([...binding.tasks]) }));
  }

  const permits = new WeakMap();
  const closed = new AbortController();
  const evaluate = execution => {
    if (closed.signal.aborted || execution?.signal?.aborted) return { kind: 'cancel' };
    const binding = tools.get(execution?.name);
    if (!binding) return deny('DSH_TOOL_NOT_BOUND', 'This tool is not bound to the project Run.');
    try {
      const current = readPolicy(execution);
      if (isPromise(current)) { void current.catch(() => {}); return unavailable(); }
      if (!current || typeof current.projectId !== 'string' || !current.projectId || typeof current.runId !== 'string' || !current.runId
        || !['string', 'number'].includes(typeof current.version) || String(current.version) === '') return unavailable();
      if (typeof current.version === 'number' && !Number.isFinite(current.version)) return unavailable();
      for (const key of ['granted', 'allowedPaths', 'networkAllowlist']) {
        const value = current.capabilities?.[key];
        if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) return unavailable();
      }
      if (current.active !== true) return deny('DSH_RUN_INACTIVE', 'The owning project Run is no longer active.');
      const policy = Object.freeze({
        projectId: current.projectId, runId: current.runId, version: current.version,
        role: current.role, task: current.task, mode: current.mode,
        capabilities: Object.freeze({
          granted: Object.freeze([...(current.capabilities?.granted || [])]),
          allowedPaths: Object.freeze([...(current.capabilities?.allowedPaths || [])]),
          networkAllowlist: Object.freeze([...(current.capabilities?.networkAllowlist || [])])
        })
      });
      if (!binding.roles.includes(policy.role) || !binding.tasks.includes(policy.task)) {
        return deny('DSH_TOOL_BINDING_DENIED', 'This role and task cannot use the tool.');
      }
      if (!policy.capabilities.granted.includes(binding.capability)) return deny('CAPABILITY_DENIED', 'The project capability is not granted.');
      if (!['auto', 'manual'].includes(policy.mode)) return unavailable();
      const checked = binding.check(execution, policy);
      if (isPromise(checked)) void checked.catch(() => {});
      if (checked !== true) return deny('DSH_TOOL_ARGUMENTS_DENIED', 'The tool arguments or resource scope are not authorized.');
      const stamp = JSON.stringify([policy.projectId, policy.runId, policy.version, policy.role, policy.task, policy.mode]);
      return { kind: 'allow', policy, stamp };
    } catch {
      return unavailable();
    }
  };

  // This final guard is intentionally separate from the extensible waterfall:
  // an unrelated listener returning allow must not override a project denial.
  ctx.tools.guard(execution => {
    const current = evaluate(execution);
    if (current.kind === 'cancel') return 'The project tool call was cancelled.';
    if (current.kind === 'deny') return current.reason;
    const permit = permits.get(execution);
    if (!permit || permit.stamp !== current.stamp) return 'The tool has no current project authorization.';
    if (onDecision) {
      try {
        const recorded = onDecision({ type: 'tool/policy', callId: execution.callId, tool: execution.name,
          projectId: current.policy.projectId, runId: current.policy.runId,
          actor: permit.actor, policyVersion: current.policy.version, decision: 'allow' });
        if (isPromise(recorded)) {
          void recorded.catch(() => {});
          return 'The project policy recorder must be synchronous.';
        }
      } catch { return 'The project policy decision could not be recorded.'; }
      const latest = evaluate(execution);
      if (latest.kind !== 'allow' || latest.stamp !== permit.stamp) return 'The project policy changed before tool dispatch.';
    }
    return undefined;
  });

  ctx.on('tools/pre-execute', async (execution, next) => {
    permits.delete(execution);
    const initial = evaluate(execution);
    if (initial.kind !== 'allow') return initial;
    let actor = 'system';
    if (initial.policy.mode === 'manual') {
      if (typeof requestApproval !== 'function') return deny('DSH_APPROVAL_UNAVAILABLE', 'Manual mode requires a project approval channel.');
      try {
        const signal = AbortSignal.any([execution.signal, closed.signal]);
        const approval = await requestApproval({ execution, policy: initial.policy, signal });
        if (signal.aborted || approval?.decision === 'cancel') return { kind: 'cancel' };
        if (approval?.decision !== 'approve' || approval.actor !== 'human' || approval.policyVersion !== initial.policy.version) {
          return deny('DSH_APPROVAL_DENIED', 'The tool did not receive approval for the current policy.');
        }
        actor = 'human';
      } catch {
        if (execution.signal.aborted || closed.signal.aborted) return { kind: 'cancel' };
        return deny('DSH_APPROVAL_UNAVAILABLE', 'The project approval channel failed.');
      }
    }
    const downstream = await next();
    if (!['allow', 'ask'].includes(downstream?.kind)) return downstream;
    const current = evaluate(execution);
    if (current.kind !== 'allow') return current;
    if (current.stamp !== initial.stamp) return deny('DSH_POLICY_CHANGED', 'The project policy changed before tool dispatch.');
    permits.set(execution, { stamp: current.stamp, actor });
    return downstream;
  });

  // Keep the denial guard registered until the owning DSH context is disposed.
  // Removing it on close would re-enable tools while calls are still settling.
  return Object.freeze({ close: () => closed.abort() });
}
