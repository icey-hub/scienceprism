import { createHash } from 'node:crypto';
import { ExperimentRunnerError } from '../experimentRunner/errors.js';
import { HarnessRuntimeError } from './errors.js';
import { isPathAllowed } from './capabilities.js';
import { intersectPaths } from './currentToolPolicy.js';

const TOOL = 'research_run_experiment';
const fail = (code, message, status = 403) => new HarnessRuntimeError(status, code, message);
const text = (value, limit = 400) => {
  if (typeof value !== 'string') return '';
  const bytes = Buffer.from(value); let end = Math.min(limit, bytes.length);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
};
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const hash = manifest => createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

function policySnapshot(value) {
  if (!value || !['projectId', 'runId', 'role', 'task', 'version'].every(key => identity(value[key]))
    || typeof value.active !== 'boolean' || !['auto', 'manual'].includes(value.mode)
    || !['granted', 'allowedPaths', 'networkAllowlist'].every(key => Array.isArray(value.capabilities?.[key])
      && value.capabilities[key].every(item => typeof item === 'string'))) throw fail('DSH_POLICY_UNAVAILABLE', 'The current experiment policy is invalid.');
  return Object.freeze({ ...Object.fromEntries(['projectId', 'runId', 'role', 'task', 'version', 'active', 'mode'].map(key => [key, value[key]])),
    capabilities: Object.freeze(Object.fromEntries(['granted', 'allowedPaths', 'networkAllowlist'].map(key => [key, Object.freeze([...value.capabilities[key]])]))) });
}
function argumentsFor(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some(key => !['tool', 'callId', 'arguments'].includes(key))
    || call.tool !== TOOL || !identity(call.callId)) throw fail('DSH_ARGUMENTS_INVALID', 'A bounded experiment tool identity is required.', 400);
  const args = call.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['runId', 'expectedManifestSha256'].includes(key))
    || !identity(args.runId) || !/^[a-f0-9]{64}$/.test(args.expectedManifestSha256 || '') || typeof args.expectedManifestSha256 !== 'string') {
    throw fail('DSH_ARGUMENTS_INVALID', 'Only an existing experiment identity and exact manifest hash are accepted.', 400);
  }
  return { runId: args.runId, expectedManifestSha256: args.expectedManifestSha256 };
}
function checkedRun(run, projectId, args) {
  if (!run || run.id !== args.runId || run.projectId !== projectId || !run.manifest || run.manifest.id !== args.runId
    || run.manifest.projectId !== projectId) throw fail('DSH_EXPERIMENT_RESULT_INVALID', 'The experiment does not belong to this project and request.', 502);
  if (hash(run.manifest) !== args.expectedManifestSha256) throw fail('EXPERIMENT_MANIFEST_CHANGED', 'The fixed experiment manifest changed.', 409);
  return run;
}
function hasBinding(run, parentRunId, manifestSha256, version) {
  const binding = run.executionBinding;
  return binding && Object.keys(binding).length === 3 && binding.parentRunId === parentRunId
    && binding.manifestSha256 === manifestSha256 && identity(binding.policyVersion)
    && (version === undefined || binding.policyVersion === version);
}
function summary(run, manifestSha256) {
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) throw fail('DSH_EXPERIMENT_RESULT_INVALID', 'The experiment did not return a terminal execution record.', 502);
  if (run.execution?.process?.stopConfirmed !== true) throw fail('EXPERIMENT_STOP_UNCONFIRMED', 'The experiment process has not confirmed stopping.', 409);
  const result = { id: run.id, actualRunId: run.id, experimentRunId: run.id, projectId: run.projectId, status: run.status, manifestSha256,
    parentRunId: run.executionBinding.parentRunId,
    execution: { startedAt: text(run.execution?.startedAt, 40), finishedAt: text(run.execution?.finishedAt, 40),
      exitCode: Number.isSafeInteger(run.execution?.exitCode) ? run.execution.exitCode : null,
      signal: text(run.execution?.signal, 40), isolation: text(run.execution?.isolation, 100) },
    code: { version: text(run.manifest.code?.version, 400), snapshotHash: text(run.manifest.code?.snapshotHash, 64) },
    dataset: { id: text(run.manifest.dataset?.id), version: text(run.manifest.dataset?.version), evidenceId: text(run.manifest.dataset?.evidenceId) },
    environment: Object.fromEntries(['node', 'platform', 'arch', 'runner', 'packageLockSha256', 'recorded'].map(key => [key, text(run.manifest.environment?.[key], 1000)])),
    metrics: (Array.isArray(run.metrics) ? run.metrics : []).slice(0, 200).map(metric => ({ name: text(metric.name, 200),
      value: typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : text(metric.value, 1000), unit: text(metric.unit, 100) })),
    artifacts: (Array.isArray(run.artifacts) ? run.artifacts : []).slice(0, 100).map(artifact => ({ id: text(artifact.id), name: text(artifact.name),
      kind: text(artifact.kind, 40), path: text(artifact.path, 2000), sha256: text(artifact.sha256, 64) })),
    evidence: { runId: text(run.evidence?.runId), artifactIds: (Array.isArray(run.evidence?.artifactIds) ? run.evidence.artifactIds : []).slice(0, 120).map(id => text(id)) },
    error: run.error ? { code: text(run.error.code, 100), retryable: run.error.retryable === true } : null,
    evidenceConfirmed: false, supportsSuccessfulFinding: false,
    truncated: (run.metrics?.length || 0) > 200 || (run.artifacts?.length || 0) > 100 || (run.evidence?.artifactIds?.length || 0) > 120 };
  while (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024 && (result.metrics.length || result.artifacts.length)) {
    if (result.metrics.length > result.artifacts.length) result.metrics.pop(); else result.artifacts.pop(); result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw fail('DSH_EXPERIMENT_RESULT_INVALID', 'The experiment summary exceeds its controlled output limit.', 502);
  return result;
}

/** Executes only an already approved, fixed ExperimentRunner manifest. No plan,
 * command, approval or manuscript mutation is accepted from the model. */
export async function createDshExperimentBroker({ readPolicy, onDecision, signal, emit = () => {},
  getRun = async (...args) => (await import('../experimentRunner/index.js')).getExperimentRun(...args),
  start = async (...args) => (await import('../experimentRunner/index.js')).startExperimentRun(...args) } = {}) {
  if (![readPolicy, onDecision, emit, getRun, start].every(value => typeof value === 'function')) throw fail('DSH_POLICY_UNAVAILABLE', 'Current policy and persisted experiment decisions are required.');
  const ceiling = policySnapshot(await readPolicy());
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const calls = new Map(), startedRuns = new Set(); let pending = Promise.resolve();
  const current = async version => {
    const policy = policySnapshot(await readPolicy());
    if (combined.aborted) throw fail('DSH_CANCELLED', 'The experiment request was cancelled.');
    if (!ceiling.active || !policy.active) throw fail('DSH_RUN_INACTIVE', 'The owning research Run is inactive.');
    if (['projectId', 'runId', 'role', 'task'].some(key => policy[key] !== ceiling[key])) throw fail('DSH_OWNER_CHANGED', 'The experiment request no longer belongs to its bound Run and role.');
    if (![ceiling, policy].every(value => value.mode === 'auto')) throw fail('DSH_APPROVAL_UNAVAILABLE', 'The owning Run must authorize automatic experiment tools.');
    if (![ceiling, policy].every(value => value.capabilities.granted.includes('experiment.execute'))) throw fail('CAPABILITY_DENIED', 'This Run does not permit experiment execution.');
    if (version !== undefined && policy.version !== version) throw fail('DSH_POLICY_CHANGED', 'The current experiment policy changed.');
    return policy;
  };
  const readRun = async args => checkedRun(await getRun(ceiling.projectId, args.runId), ceiling.projectId, args);
  const fileScope = (run, policy) => {
    const paths = [...(run.manifest.code?.files || []).map(file => file.path), run.manifest.command?.entrypoint,
      ...(run.manifest.artifacts || []).map(artifact => artifact.path)].filter(Boolean);
    if (paths.some(path => ![ceiling, policy].every(value => isPathAllowed(path, value.capabilities)))) throw fail('PATH_DENIED', 'The fixed experiment inputs or outputs exceed this Run file scope.');
    const allowedPaths = intersectPaths(ceiling.capabilities.allowedPaths, policy.capabilities.allowedPaths);
    if (ceiling.capabilities.allowedPaths.length && policy.capabilities.allowedPaths.length && !allowedPaths.length) throw fail('PATH_DENIED', 'The current file scope does not intersect the owning Run scope.');
    return allowedPaths;
  };
  const record = (entry, policy, decision, reasonCode) => onDecision({ type: 'tool/policy', tool: TOOL, callId: entry.callId,
    projectId: ceiling.projectId, runId: ceiling.runId, capability: 'experiment.execute', actor: 'system',
    policyVersion: policy?.version ?? ceiling.version, decision, ...(reasonCode ? { reasonCode } : {}) });
  async function execute(entry) {
    let policy;
    try {
      policy = await current(); entry.version = policy.version;
      try { await record(entry, policy, 'allow'); } catch { throw fail('DSH_AUDIT_UNAVAILABLE', 'The experiment decision could not be persisted.'); }
      await current(entry.version);
      let run = await readRun(entry.args);
      const allowedPaths = fileScope(run, await current(entry.version));
      if (run.status === 'completed') {
        if (!hasBinding(run, ceiling.runId, entry.args.expectedManifestSha256)) throw fail('EXPERIMENT_OWNER_CHANGED', 'The completed experiment belongs to another execution.', 409);
      } else {
        if (run.status !== 'approved' || run.approval?.decision !== 'approve') throw fail('EXPERIMENT_APPROVAL_REQUIRED', 'Only an already approved experiment can be started.', 409);
        if (run.executionBinding && !hasBinding(run, ceiling.runId, entry.args.expectedManifestSha256, entry.version)) throw fail('EXPERIMENT_OWNER_CHANGED', 'The approved experiment belongs to another execution.', 409);
        if (startedRuns.has(run.id)) throw fail('DSH_EXPERIMENT_ALREADY_REQUESTED', 'This experiment was already requested and will not be restarted.', 409);
        const executionBinding = { parentRunId: ceiling.runId, policyVersion: entry.version, manifestSha256: entry.args.expectedManifestSha256 };
        startedRuns.add(run.id);
        let launchFailure;
        run = await start(ceiling.projectId, run.id, { wait: true, signal: combined, executionBinding, allowedPaths,
          beforeLaunch: async () => {
            try {
              await current(entry.version);
              const latest = await readRun(entry.args);
              fileScope(latest, await current(entry.version));
              if (latest.status !== 'running' || latest.approval?.decision !== 'approve'
                || !hasBinding(latest, ceiling.runId, entry.args.expectedManifestSha256, entry.version)) throw fail('EXPERIMENT_OWNER_CHANGED', 'The experiment execution state changed before launch.', 409);
              await current(entry.version);
            } catch (reason) { launchFailure = reason; throw reason; }
          } });
        // The runner archives pre-launch failures as failed Runs. Retain the
        // original policy denial for the tool response without losing that Run.
        if (launchFailure) throw launchFailure;
        checkedRun(run, ceiling.projectId, entry.args);
        if (!hasBinding(run, ceiling.runId, entry.args.expectedManifestSha256, entry.version)) throw fail('EXPERIMENT_OWNER_CHANGED', 'The execution result belongs to another parent.', 409);
      }
      await current(entry.version);
      const result = summary(run, entry.args.expectedManifestSha256);
      emit({ type: 'research/experiment', data: { name: TOOL, callId: entry.callId, experimentRunId: result.id,
        projectId: ceiling.projectId, status: result.status, outputSummary: result, evidenceConfirmed: false } });
      return result;
    } catch (reason) {
      try { await record(entry, policy, 'deny', reason instanceof HarnessRuntimeError || reason instanceof ExperimentRunnerError ? reason.code : 'DSH_EXPERIMENT_FAILED'); }
      catch { throw fail('DSH_AUDIT_UNAVAILABLE', 'The experiment decision could not be persisted.'); }
      if (combined.aborted) throw fail('DSH_CANCELLED', 'The experiment request was cancelled.');
      if (reason instanceof HarnessRuntimeError || reason instanceof ExperimentRunnerError) throw new HarnessRuntimeError(reason.statusCode, reason.code,
        'The controlled experiment request could not complete.', undefined, { retryable: reason.retryable });
      throw fail('DSH_EXPERIMENT_FAILED', 'The controlled experiment request could not complete.', 502);
    }
  }
  return Object.freeze({ ceiling,
    execute(call) {
      let args;
      try { args = argumentsFor(call); } catch (reason) { return Promise.reject(reason); }
      const fingerprint = JSON.stringify(args), previous = calls.get(call.callId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return Promise.reject(fail('DSH_CALL_CONFLICT', 'This tool identity belongs to different experiment arguments.', 409));
        return previous.promise.then(async result => {
          await current(previous.version);
          const run = await readRun(args);
          fileScope(run, await current(previous.version));
          if (run.execution?.process?.stopConfirmed !== true) throw fail('EXPERIMENT_STOP_UNCONFIRMED', 'The saved experiment process has not confirmed stopping.', 409);
          if (run.status !== result.status || !hasBinding(run, ceiling.runId, args.expectedManifestSha256)) throw fail('EXPERIMENT_OWNER_CHANGED', 'The saved experiment outcome no longer matches this execution.', 409);
          await current(previous.version); return structuredClone(result);
        });
      }
      if (combined.aborted) return Promise.reject(fail('DSH_CANCELLED', 'The experiment request was cancelled.'));
      if (calls.size >= 32) return Promise.reject(fail('DSH_EXPERIMENT_LIMIT', 'This Run reached its experiment call identity limit.', 429));
      const entry = { callId: call.callId, args, fingerprint, version: undefined };
      entry.promise = pending.then(() => execute(entry)); pending = entry.promise.catch(() => {}); calls.set(entry.callId, entry);
      return entry.promise.then(result => structuredClone(result));
    },
    close() { controller.abort(); return pending; }
  });
}
