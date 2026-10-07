import { createRunExecutor, summarizeEvent } from './execution.js';
import { collectFiles, collectPatches, copyWorkspace } from './workspace.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../../config/constants.js';
import { PROJECT_CONSTRAINT_LIMITS } from '../../config/projectConstraintDefaults.js';
import {
  applyProjectConstraintPolicy,
  assertProjectPath,
  DEFAULT_PROJECT_CAPABILITIES,
  resolveCapabilityPolicy
} from './capabilities.js';
import { HarnessRuntimeError } from './errors.js';
import { clone, readHarnessRuns, resolveHarnessProjectRoot, withHarnessRunLock, writeHarnessRuns } from './repository.js';
import { deepseekHarnessAdapter } from './adapters/deepseekAdapter.js';
import { legacyHarnessAdapter } from './adapters/legacyAdapter.js';
import { fakeHarnessAdapter } from './adapters/fakeAdapter.js';
import { buildContextPack, contextManifest } from './contextPackager.js';
import { assertProjectFeatureEnabled } from '../featureFlags.js';
import { getRole, resolveRoleCapabilities } from '../agentRoles/index.js';
import { applyPatchTransaction, selectPatchPaths } from './patchApplication.js';
import { isConstraintEnabled, readConstraintPolicy } from '../constraintRegistry/index.js';
import { readFileState, sameVersion } from './fileVersions.js';

const MAX_RECENT_RUNS = 100;

/**
 * The statuses that mean a Harness Run has finished.
 *
 * Exported because observability asks the same question. Four call sites used to
 * repeat the literal list across two modules, so adding a terminal status meant
 * finding all of them; missing one would leave a finished Run looking active in
 * the run centre, or make decideHarnessRun refuse a Run that had already ended.
 */
export const TERMINAL_HARNESS_RUN_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
const adapters = new Map([
  ['deepseek', deepseekHarnessAdapter],
  ['legacy', legacyHarnessAdapter],
  ['fake', fakeHarnessAdapter]
]);
const activeRuns = new Map();
const pendingRequests = new Map();
const runtimeInstanceId = randomUUID();
const executeRun = createRunExecutor({
  getRun: getHarnessRun,
  updateRun,
  adapterFor: (id) => adapters.get(id),
  forgetRequest: (id) => pendingRequests.delete(id)
});

function now() {
  return new Date().toISOString();
}

function normalizeAdapter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'harness' || normalized === 'deepseek-harness' || normalized === 'deepseek') return 'deepseek';
  if (normalized === 'langchain' || normalized === 'legacy') return 'legacy';
  if (normalized === 'fake' || normalized === 'test') return 'fake';
  return 'deepseek';
}

function sanitizeRequest(request = {}) {
  const safe = clone(request) || {};
  if (safe.llmConfig && typeof safe.llmConfig === 'object') {
    delete safe.llmConfig.apiKey;
    delete safe.llmConfig.token;
    delete safe.llmConfig.secret;
  }
  delete safe.adapterInstance;
  delete safe.signal;
  delete safe.contextPack;
  return safe;
}

export async function readProjectConstraints(projectRoot) {
  for (const relativePath of ['.scienceprism/project-constraints.json', '.scienceprism/harness-constraints.json']) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(projectRoot, relativePath), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new HarnessRuntimeError(400, 'INVALID_PROJECT_CONSTRAINTS', `Project constraints are not valid JSON: ${relativePath}.`);
      }
    }
  }
  return {};
}

function numberOr(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function buildLimits(request, policy, budgetEnabled = true) {
  const constraints = policy.constraints || {};
  const defaultTimeout = budgetEnabled ? PROJECT_CONSTRAINT_LIMITS.timeoutMs : 24 * 60 * 60 * 1000;
  const defaultTokens = budgetEnabled ? PROJECT_CONSTRAINT_LIMITS.maxTokens : 1_000_000;
  return {
    timeoutMs: numberOr(request.limits?.timeoutMs, budgetEnabled ? numberOr(constraints.timeoutMs, defaultTimeout, { min: 100, max: 24 * 60 * 60 * 1000 }) : defaultTimeout, { min: 100, max: 24 * 60 * 60 * 1000 }),
    maxTokens: numberOr(request.limits?.maxTokens, budgetEnabled ? numberOr(constraints.maxTokens, defaultTokens, { min: 1, max: 1_000_000 }) : defaultTokens, { min: 1, max: 1_000_000 }),
    maxConcurrent: numberOr(request.limits?.maxConcurrent, numberOr(constraints.maxConcurrent, PROJECT_CONSTRAINT_LIMITS.maxConcurrent, { min: 1, max: 32 }), { min: 1, max: 32 }),
    retryLimit: numberOr(request.limits?.retryLimit, numberOr(constraints.retryLimit, PROJECT_CONSTRAINT_LIMITS.retryLimit, { min: 0, max: 10 }), { min: 0, max: 10 })
  };
}

async function getRunDocument(projectId) {
  const root = await resolveHarnessProjectRoot(projectId);
  const document = await withHarnessRunLock(projectId, async () => {
    const stored = await readHarnessRuns(root, projectId);
    let recovered = false;
    for (const run of stored.runs) {
      if ((run.status === 'running' && !activeRuns.has(run.id)) ||
          (run.status === 'created' && run.request?.source === 'editor' && run.runtimeInstanceId !== runtimeInstanceId)) {
        run.status = 'failed';
        run.finishedAt = now();
        run.updatedAt = run.finishedAt;
        run.error = { code: 'HARNESS_INTERRUPTED', message: 'The server restarted before this task finished. Retry with the current document.', retryable: true };
        recovered = true;
      }
    }
    if (recovered) await writeHarnessRuns(root, stored);
    return stored;
  });
  return { root, document };
}

async function updateRun(projectId, runId, updater) {
  const { root } = await getRunDocument(projectId);
  return withHarnessRunLock(projectId, async () => {
    const document = await readHarnessRuns(root, projectId);
    const index = document.runs.findIndex((run) => run.id === runId);
    if (index < 0) throw new HarnessRuntimeError(404, 'HARNESS_RUN_NOT_FOUND', 'Harness Run not found.', { runId });
    const next = clone(document.runs[index]);
    const value = await updater(next);
    document.runs[index] = value || next;
    await writeHarnessRuns(root, document);
    return clone(document.runs[index]);
  });
}

function activeCount(projectId) {
  return [...activeRuns.values()].filter((entry) => entry.projectId === projectId).length;
}

function assertRunnableStatus(run) {
  if (!['created', 'paused', 'failed'].includes(run.status)) {
    throw new HarnessRuntimeError(409, 'HARNESS_RUN_NOT_RUNNABLE', `Harness Run is ${run.status} and cannot be started.`);
  }
  if (run.status !== 'created' && run.attempt > run.limits.retryLimit) {
    throw new HarnessRuntimeError(409, 'HARNESS_RETRY_LIMIT', 'Harness Run retry limit has been exhausted.', { retryLimit: run.limits.retryLimit });
  }
}

function mergeRequest(run, overrides = {}) {
  const base = pendingRequests.get(run.id) || run.request || {};
  return {
    ...base,
    ...overrides,
    projectId: run.projectId,
    llmConfig: { ...(base.llmConfig || {}), ...(overrides.llmConfig || {}) }
  };
}

function normalizeDocumentVersions(request = {}) {
  const values = Array.isArray(request.documentVersions)
    ? request.documentVersions
    : request.document && typeof request.document === 'object' ? [request.document] : [];
  return values.map((item) => ({
    path: String(item?.path || item?.filePath || '').replace(/\\/g, '/'),
    exists: item?.exists !== false,
    sha256: item?.sha256 || item?.hash || null
  }));
}

async function assertDocumentVersions(root, versions, policy) {
  for (const expected of versions) {
    if (!expected.path || (expected.exists ? !/^[a-f0-9]{64}$/.test(expected.sha256) : expected.sha256 !== null)) {
      throw new HarnessRuntimeError(400, 'INVALID_DOCUMENT_VERSION', 'Each document version requires a relative path and SHA-256 hash.', { path: expected.path });
    }
    const relativePath = assertProjectPath(expected.path, policy, { operation: 'read' });
    const current = await readFileState(root, relativePath);
    const expectedVersion = { exists: expected.exists, sha256: expected.exists ? expected.sha256.toLowerCase() : null };
    if (!sameVersion(current, expectedVersion)) {
      throw new HarnessRuntimeError(409, 'DOCUMENT_VERSION_CONFLICT', 'The saved document changed before this Run started.', {
        path: relativePath,
        expected: expectedVersion,
        actual: { exists: current.exists, sha256: current.sha256 }
      });
    }
  }
}

export async function createHarnessRun(projectId, request = {}) {
  const projectRoot = await resolveHarnessProjectRoot(projectId);
  const constraintPolicy = await readConstraintPolicy(projectId);
  const parent = request.parentRunId ? await getHarnessRun(projectId, request.parentRunId) : null;
  if (parent) {
    if (parent.archived || parent.parentRunId || parent.status !== 'created') {
      throw new HarnessRuntimeError(409, 'INVALID_DELEGATION_PARENT', 'A child Run requires an unstarted root Run in the same project.');
    }
    if (!request.delegationTask || typeof request.delegationTask !== 'string' || request.delegationTask.length > 80) {
      throw new HarnessRuntimeError(400, 'INVALID_DELEGATION_TASK', 'A child Run requires a bounded delegation task.');
    }
    if (!Array.isArray(request.capabilities) || request.capabilities.some((capability) => !parent.capabilities.granted.includes(capability))) {
      throw new HarnessRuntimeError(403, 'DELEGATION_CAPABILITY_DENIED', 'A child Run may only request capabilities granted to its parent.');
    }
  } else if (request.delegationTask) {
    throw new HarnessRuntimeError(400, 'INVALID_DELEGATION_TASK', 'A delegation task requires a parent Run.');
  }
  const constraints = await readProjectConstraints(projectRoot);
  const configuredCapabilities = constraints.capabilities || DEFAULT_PROJECT_CAPABILITIES;
  const requestedCapabilities = request.capabilities;
  const capabilities = applyProjectConstraintPolicy(
    resolveCapabilityPolicy({ requested: requestedCapabilities, configured: configuredCapabilities }),
    constraints
  );
  const adapter = normalizeAdapter(request.adapter || request.runtime || request.llmConfig?.runtime || getEnv('AGENT_RUNTIME'));
  // C-16 covers "advanced Harness adapters" plural. Only the in-process fake
  // adapter that tests rely on is exempt; every real adapter is rollout-gated.
  if (adapter !== 'fake') await assertProjectFeatureEnabled(projectId, 'advancedHarness', { adapter });
  // A named role narrows what this Run may do: the effective grant is the
  // intersection of the Project's grant and the role's allowance, so naming a
  // role can only ever remove capabilities. An unknown role fails closed rather
  // than silently running unconstrained.
  const role = request.role ? getRole(request.role) : null;
  if (request.role && !role) {
    throw new HarnessRuntimeError(400, 'UNKNOWN_ROLE', `Unknown agent role: ${request.role}.`, { role: request.role });
  }
  const narrowed = role ? resolveRoleCapabilities(role.id, capabilities) : null;
  const effectiveCapabilities = role
    ? {
        ...capabilities,
        granted: narrowed.granted,
        denied: [...new Set([...capabilities.denied, ...narrowed.denied])],
        role: role.id,
        roleAuthority: role.authority
      }
    : capabilities;
  const documentVersions = normalizeDocumentVersions(request);
  await assertDocumentVersions(projectRoot, documentVersions, effectiveCapabilities);
  const contextPack = await buildContextPack({
    projectId,
    projectRoot,
    request: { ...request, adapter },
    policy: effectiveCapabilities,
    constraints
  });
  for (const expected of documentVersions) {
    const packed = contextPack.files.find((file) => file.path === expected.path);
    if (packed && packed.sha256 !== expected.sha256) {
      throw new HarnessRuntimeError(409, 'DOCUMENT_VERSION_CONFLICT', 'The document changed while context was being captured.', { path: expected.path });
    }
  }
  const createdAt = now();
  const run = {
    schemaVersion: 1,
    runtimeInstanceId,
    id: randomUUID(),
    projectId,
    stage: request.stage || null,
    task: request.task || 'polish',
    adapter,
    adapterHistory: [],
    status: 'created',
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    attempt: 0,
    replayOf: request.replayOf || null,
    parentRunId: parent?.id || null,
    delegationTask: parent ? request.delegationTask : null,
    delegationDepth: parent ? 1 : 0,
    role: role?.id || null,
    roleAuthority: role?.authority || null,
    model: request.llmConfig?.model || getEnv('HARNESS_MODEL') || process.env.DEEPSEEK_MODEL || (adapter === 'deepseek' ? 'deepseek-flash' : null),
    skills: Array.isArray(request.researchSkills) ? request.researchSkills : [],
    contextHash: contextPack.contextHash,
    documentVersions,
    contextManifest: contextManifest(contextPack),
    contextPack,
    capabilities: effectiveCapabilities,
    limits: buildLimits(request, effectiveCapabilities, isConstraintEnabled(constraintPolicy, 'C-10')),
    fallback: request.fallback !== false && getEnv('HARNESS_FALLBACK') !== 'false' && effectiveCapabilities.constraints?.fallback !== false,
    request: sanitizeRequest({ ...request, projectId, adapter }),
    events: [],
    patches: [],
    tokenUsage: null,
    humanDecision: { status: 'none' },
    outputValidation: null,
    error: null
  };
  await withHarnessRunLock(projectId, async () => {
    const document = await readHarnessRuns(projectRoot, projectId);
    if (parent && !document.runs.some((item) => item.id === parent.id && item.status === 'created')) {
      throw new HarnessRuntimeError(409, 'INVALID_DELEGATION_PARENT', 'The parent Run is no longer available for delegation.');
    }
    const allRuns = [run, ...document.runs];
    const olderRuns = allRuns.slice(MAX_RECENT_RUNS);
    // Editor history includes replies, request ids and undecided proposals. A
    // summary archive cannot restore those, so keep editor Runs in full.
    const archivable = olderRuns.filter((old) => old.request?.source !== 'editor' && TERMINAL_HARNESS_RUN_STATUSES.includes(old.status));
    const archivedIds = new Set(archivable.map((old) => old.id));
    document.runs = allRuns.filter((old) => !archivedIds.has(old.id));
    document.archivedRuns = [
      ...(document.archivedRuns || []),
      ...archivable.map((old) => ({
        id: old.id,
        projectId: old.projectId,
        parentRunId: old.parentRunId || null,
        delegationTask: old.delegationTask || null,
        role: old.role,
        stage: old.stage,
        task: old.task,
        status: old.status,
        createdAt: old.createdAt,
        finishedAt: old.finishedAt,
        tokenUsage: old.tokenUsage,
        archived: true
      }))
    ];
    await writeHarnessRuns(projectRoot, document);
  });
  pendingRequests.set(run.id, { ...request, projectId, adapter });
  return clone(run);
}

export async function getHarnessRun(projectId, runId) {
  const { document } = await getRunDocument(projectId);
  const run = document.runs.find((item) => item.id === runId) || (document.archivedRuns || []).find((item) => item.id === runId);
  if (!run) throw new HarnessRuntimeError(404, 'HARNESS_RUN_NOT_FOUND', 'Harness Run not found.', { runId });
  return clone(run);
}

export async function listHarnessRuns(projectId, { status, stage, parentRunId, source, requestId, limit = 50 } = {}) {
  const { document } = await getRunDocument(projectId);
  const max = numberOr(limit, 50, { min: 1, max: 100 });
  const includeArchived = Boolean(parentRunId || source || requestId);
  return (includeArchived ? [...document.runs, ...(document.archivedRuns || [])] : document.runs)
    .filter((run) => (!status || run.status === status) && (!stage || run.stage === stage))
    .filter((run) => (!parentRunId || run.parentRunId === parentRunId))
    .filter((run) => (!source || run.request?.source === source))
    .filter((run) => (!requestId || run.request?.requestId === requestId))
    .slice(0, max)
    .map(clone);
}

export async function startHarnessRun(projectId, runId, { wait = false, request = {} } = {}) {
  const run = await getHarnessRun(projectId, runId);
  assertRunnableStatus(run);
  if (run.parentRunId) {
    const parent = await getHarnessRun(projectId, run.parentRunId);
    if (parent.status !== 'created') {
      throw new HarnessRuntimeError(409, 'INVALID_DELEGATION_PARENT', 'The parent Run must remain unstarted while a child executes.');
    }
  } else {
    const children = await listHarnessRuns(projectId, { parentRunId: run.id, limit: 100 });
    if (children.some((child) => !TERMINAL_HARNESS_RUN_STATUSES.includes(child.status))) {
      throw new HarnessRuntimeError(409, 'DELEGATION_IN_PROGRESS', 'Finish or cancel child Runs before starting their parent.');
    }
  }
  if (run.capabilities.denied?.length) {
    const denied = await updateRun(projectId, runId, (current) => {
      current.status = 'failed';
      current.finishedAt = now();
      current.updatedAt = current.finishedAt;
      current.error = { code: 'CAPABILITY_DENIED', message: 'Requested Harness capabilities were not granted by the Project Constraints.', retryable: false, details: { denied: current.capabilities.denied } };
      return current;
    });
    return denied;
  }
  const existing = activeRuns.get(runId);
  if (existing) return wait && existing.promise ? existing.promise : getHarnessRun(projectId, runId);
  if (activeCount(projectId) >= run.limits.maxConcurrent) {
    throw new HarnessRuntimeError(409, 'HARNESS_CONCURRENCY_LIMIT', 'Project Harness concurrency limit reached.', { maxConcurrent: run.limits.maxConcurrent });
  }
  const controller = new AbortController();
  const control = { controller, pauseRequested: false, cancelRequested: false, timeoutError: null, violation: null };
  activeRuns.set(runId, { projectId, controller, control, promise: null });
  let started;
  try {
    started = await updateRun(projectId, runId, (current) => {
      assertRunnableStatus(current);
      current.status = 'running';
      current.attempt += 1;
      current.startedAt = current.startedAt || now();
      current.updatedAt = now();
      current.error = null;
      return current;
    });
  } catch (error) {
    activeRuns.delete(runId);
    throw error;
  }
  const effectiveRequest = mergeRequest(started, request);
  const promise = executeRun(projectId, runId, effectiveRequest, control).finally(() => activeRuns.delete(runId));
  activeRuns.set(runId, { projectId, controller, control, promise });
  return wait ? promise : started;
}

export async function waitForHarnessRun(projectId, runId) {
  const active = activeRuns.get(runId);
  return active?.promise || getHarnessRun(projectId, runId);
}

export async function pauseHarnessRun(projectId, runId) {
  const active = activeRuns.get(runId);
  if (!active) {
    const run = await getHarnessRun(projectId, runId);
    if (run.status === 'created' || run.status === 'failed') return updateRun(projectId, runId, (current) => ({ ...current, status: 'paused', updatedAt: now() }));
    return run;
  }
  active.control.pauseRequested = true;
  active.controller.abort(Object.assign(new Error('Harness Run paused.'), { code: 'HARNESS_PAUSED' }));
  return getHarnessRun(projectId, runId);
}

export async function resumeHarnessRun(projectId, runId, options = {}) {
  return startHarnessRun(projectId, runId, options);
}

export async function cancelHarnessRun(projectId, runId) {
  const active = activeRuns.get(runId);
  if (!active) {
    return updateRun(projectId, runId, (current) => {
      if (TERMINAL_HARNESS_RUN_STATUSES.includes(current.status)) return current;
      current.status = 'cancelled';
      current.finishedAt = now();
      current.updatedAt = current.finishedAt;
      current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
      return current;
    });
  }
  active.control.cancelRequested = true;
  active.controller.abort(Object.assign(new Error('Harness Run cancelled.'), { code: 'HARNESS_CANCELLED' }));
  return active.promise || getHarnessRun(projectId, runId);
}

export async function replayHarnessRun(projectId, runId, { request = {}, start = true } = {}) {
  const original = await getHarnessRun(projectId, runId);
  const run = await createHarnessRun(projectId, { ...original.request, ...request, stage: original.stage, task: original.task, replayOf: original.id });
  return start ? startHarnessRun(projectId, run.id, { wait: true, request }) : run;
}

export async function decideHarnessRun(projectId, runId, { decision, actor = 'human', note = '', paths } = {}) {
  if (!['accept', 'reject'].includes(decision)) throw new HarnessRuntimeError(400, 'INVALID_HUMAN_DECISION', 'decision must be accept or reject.');
  return updateRun(projectId, runId, (run) => {
    if (!TERMINAL_HARNESS_RUN_STATUSES.includes(run.status)) {
      throw new HarnessRuntimeError(409, 'HARNESS_RUN_NOT_DECIDABLE', 'Only a finished Harness Run can receive a human decision.');
    }
    const selected = selectPatchPaths(run, paths);
    const record = { status: decision === 'accept' ? 'accepted' : 'rejected', actor: String(actor), note: String(note || ''), at: now() };
    run.patchDecisions = { ...(run.patchDecisions || {}) };
    for (const filePath of selected) {
      if (!(run.appliedPatches || []).includes(filePath)) run.patchDecisions[filePath] = record;
    }
    const statuses = (run.patches || []).map((patch) => run.patchDecisions[patch.path]?.status || 'pending');
    run.humanDecision = { ...record, status: !statuses.length || statuses.every((status) => status === record.status) ? record.status : 'partial' };
    run.events = [...(run.events || []), { type: 'patches.decided', at: record.at, details: { ...record, paths: [...selected] } }];
    run.updatedAt = now();
    return run;
  });
}

/**
 * Applies an accepted Run's Patches to the Project.
 *
 * C-07 states that the original project changes only through an explicit Patch
 * application, but no such path existed, so the constraint held only because it
 * was unimplemented. This is that path, and it is deliberately narrow:
 * a human must have accepted the Run first, every path is re-checked against the
 * current Project Constraint policy on the way in, a Patch is never applied
 * twice, and the Run records exactly what was written.
 */
export async function applyHarnessRunPatches(projectId, runId, { actor = 'human', paths } = {}) {
  const root = await resolveHarnessProjectRoot(projectId);
  return withHarnessRunLock(projectId, async () => {
    const document = await readHarnessRuns(root, projectId);
    const index = document.runs.findIndex((run) => run.id === runId);
    if (index < 0) throw new HarnessRuntimeError(404, 'HARNESS_RUN_NOT_FOUND', 'Harness Run not found.', { runId });
    const constraints = await readProjectConstraints(root);
    const policy = applyProjectConstraintPolicy(
      resolveCapabilityPolicy({ configured: constraints.capabilities || DEFAULT_PROJECT_CAPABILITIES }), constraints
    );
    return applyPatchTransaction({ projectId, root, document, index, policy, actor, paths });
  });
}

export async function recordHarnessRunValidation(projectId, runId, validation) {
  return updateRun(projectId, runId, (run) => {
    run.outputValidation = clone(validation);
    run.updatedAt = now();
    if (validation?.ok === false && run.status === 'completed') {
      run.status = 'failed';
      run.error = { code: 'OUTPUT_VALIDATION_FAILED', message: 'Harness output did not satisfy its output contract.', retryable: false };
    }
    return run;
  });
}

export async function runHarnessRequest(request = {}) {
  if (!request.projectId) return { ok: false, reply: 'Missing project id.', patches: [], runtime: normalizeAdapter(request.adapter) };
  const run = request.existingRunId
    ? await getHarnessRun(request.projectId, request.existingRunId)
    : await createHarnessRun(request.projectId, request);
  const result = await startHarnessRun(request.projectId, run.id, { wait: true, request });
  return {
    ok: result.status === 'completed',
    reply: result.reply || '',
    patches: result.patches || [],
    runtime: result.adapter === 'deepseek' ? 'deepseek-harness' : result.adapter,
    runId: result.id,
    sessionId: result.sessionId,
    events: result.events || [],
    fallback: result.fallback || false,
    harnessError: result.harnessError,
    error: result.error || undefined,
    outputValidation: result.outputValidation || undefined
  };
}

/**
 * Intentionally unused today, and deliberately kept: it is the only way to add a
 * Harness Adapter (or swap one in a test) without editing this module. The three
 * shipped adapters register themselves below.
 */
export function registerHarnessAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || typeof adapter.run !== 'function') throw new TypeError('A Harness Adapter must provide id and run().');
  adapters.set(adapter.id, adapter);
  return () => adapters.delete(adapter.id);
}

export function listHarnessAdapters() {
  return [...adapters.values()].map((adapter) => ({ id: adapter.id, label: adapter.label || adapter.id }));
}

export {
  collectFiles,
  collectPatches,
  copyWorkspace,
  normalizeAdapter,
  summarizeEvent
};
