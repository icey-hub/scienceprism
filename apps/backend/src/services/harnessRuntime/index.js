import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { getEnv } from '../../config/constants.js';
import { safeJoin } from '../../utils/pathUtils.js';
import {
  applyProjectConstraintPolicy,
  capabilityForToolName,
  DEFAULT_PROJECT_CAPABILITIES,
  isPathAllowed,
  isSensitivePath,
  resolveCapabilityPolicy
} from './capabilities.js';
import { asRuntimeError, HarnessRuntimeError } from './errors.js';
import { clone, readHarnessRuns, resolveHarnessProjectRoot, withHarnessRunLock, writeHarnessRuns } from './repository.js';
import { deepseekHarnessAdapter } from './adapters/deepseekAdapter.js';
import { legacyHarnessAdapter } from './adapters/legacyAdapter.js';
import { fakeHarnessAdapter } from './adapters/fakeAdapter.js';
import { copyBundledResearchSkills, isBundledSkillPath, restrictWorkspaceResearchSkills } from '../researchResearch/researchSkills.js';
import { buildContextPack, contextManifest } from './contextPackager.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 49152;
const DEFAULT_RETRY_LIMIT = 1;
const DEFAULT_MAX_CONCURRENT = 1;
const MAX_PATCH_FILE_BYTES = 1024 * 1024;
const MAX_EVENTS = 1000;
const IGNORED_DIRS = new Set([
  '.git',
  '.scienceprism',
  '.openprism',
  '.agent_runs',
  '.cache',
  'node_modules'
]);
const IGNORED_FILES = new Set(['project.json', '.compile']);
const adapters = new Map([
  ['deepseek', deepseekHarnessAdapter],
  ['legacy', legacyHarnessAdapter],
  ['fake', fakeHarnessAdapter]
]);
const activeRuns = new Map();
const pendingRequests = new Map();

function now() {
  return new Date().toISOString();
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
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

function summarizeEvent(event = {}) {
  const source = event?.params?.event || event;
  const data = source?.data || event?.params || {};
  return {
    type: source?.type || event?.method || 'unknown',
    name: data?.name,
    callId: data?.callId,
    tool: data?.tool,
    capability: capabilityForToolName(data?.name || data?.tool),
    usage: data?.usage || data?.tokenUsage,
    text: source?.type === 'assistant/message'
      ? source.data?.message?.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('')
      : undefined,
    at: now()
  };
}

async function collectFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_FILES.has(entry.name) || IGNORED_DIRS.has(entry.name) || isSensitivePath(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else if (entry.isFile()) files.push(toPosix(child));
  }
  return files;
}

async function copyWorkspace(sourceRoot, targetRoot) {
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      return !IGNORED_DIRS.has(name) && !IGNORED_FILES.has(name) && !isSensitivePath(name);
    }
  });
}

async function readTextFile(root, relativePath) {
  const absolute = safeJoin(root, relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > MAX_PATCH_FILE_BYTES) return null;
  return fs.readFile(absolute, 'utf8');
}

async function collectPatches(originalRoot, workspaceRoot, policy, excludedPaths = []) {
  const originalFiles = await collectFiles(originalRoot);
  const workspaceFiles = await collectFiles(workspaceRoot);
  const originalSet = new Set(originalFiles);
  const workspaceSet = new Set(workspaceFiles);
  const allPaths = [...new Set([...originalFiles, ...workspaceFiles])].sort();
  const patches = [];

  for (const relativePath of allPaths) {
    if (isBundledSkillPath(relativePath, excludedPaths)) continue;
    if (!isPathAllowed(relativePath, policy, { operation: 'patch' })) continue;
    const original = originalSet.has(relativePath) ? await readTextFile(originalRoot, relativePath) : '';
    const proposed = workspaceSet.has(relativePath) ? await readTextFile(workspaceRoot, relativePath) : '';
    if (original === null || proposed === null || original === proposed) continue;
    patches.push({
      path: relativePath,
      original,
      content: proposed,
      deleted: !workspaceSet.has(relativePath),
      diff: createTwoFilesPatch(relativePath, relativePath, original, proposed, 'current', 'proposed')
    });
  }
  return patches;
}

async function readProjectConstraints(projectRoot) {
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

function buildLimits(request, policy) {
  const constraints = policy.constraints || {};
  return {
    timeoutMs: numberOr(request.limits?.timeoutMs, numberOr(constraints.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 100, max: 24 * 60 * 60 * 1000 }), { min: 100, max: 24 * 60 * 60 * 1000 }),
    maxTokens: numberOr(request.limits?.maxTokens, numberOr(constraints.maxTokens, DEFAULT_MAX_TOKENS, { min: 1, max: 1_000_000 }), { min: 1, max: 1_000_000 }),
    maxConcurrent: numberOr(request.limits?.maxConcurrent, numberOr(constraints.maxConcurrent, DEFAULT_MAX_CONCURRENT, { min: 1, max: 32 }), { min: 1, max: 32 }),
    retryLimit: numberOr(request.limits?.retryLimit, numberOr(constraints.retryLimit, DEFAULT_RETRY_LIMIT, { min: 0, max: 10 }), { min: 0, max: 10 })
  };
}

async function getRunDocument(projectId) {
  const root = await resolveHarnessProjectRoot(projectId);
  return { root, document: await readHarnessRuns(root, projectId) };
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

function patchListFromResult(result, policy) {
  const patches = Array.isArray(result?.patches) ? result.patches : [];
  return patches.filter((patch) => patch && typeof patch.path === 'string' && isPathAllowed(patch.path, policy, { operation: 'patch' }))
    .map((patch) => ({ ...patch, path: patch.path.replace(/\\/g, '/') }));
}

function timeoutPromise(ms, controller) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new HarnessRuntimeError(504, 'HARNESS_TIMEOUT', `Harness Run exceeded its ${ms}ms timeout.`, { timeoutMs: ms }, { retryable: true });
      controller.timeoutError = error;
      controller.abort(error);
      reject(error);
    }, ms);
  });
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

async function runWithTimeout(task, timeoutMs, controller) {
  const timeout = timeoutPromise(timeoutMs, controller);
  const aborted = new Promise((_, reject) => {
    const abort = () => reject(controller.signal.reason || new Error('Harness Run aborted.'));
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([task, timeout, aborted]);
  } finally {
    timeout.cancel();
  }
}

async function persistEvents(projectId, runId, events) {
  if (!events.length) return;
  await updateRun(projectId, runId, (run) => {
    run.events = [...(run.events || []), ...events].slice(-MAX_EVENTS);
    run.updatedAt = now();
    return run;
  });
}

async function executeRun(projectId, runId, request, control) {
  const run = await getHarnessRun(projectId, runId);
  const adapter = adapters.get(run.adapter);
  if (!adapter) throw new HarnessRuntimeError(500, 'HARNESS_ADAPTER_NOT_FOUND', `Unknown Harness Adapter: ${run.adapter}.`);
  if (run.capabilities.denied?.length) {
    throw new HarnessRuntimeError(403, 'CAPABILITY_DENIED', 'Requested Harness capabilities were not granted by the Project Constraints.', { denied: run.capabilities.denied });
  }

  const projectRoot = await resolveHarnessProjectRoot(projectId);
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scienceprism-harness-'));
  const workspace = path.join(runRoot, 'workspace');
  const dshHome = path.join(runRoot, 'dsh-home');
  let excludedSkillPaths = [];
  let eventWrite = Promise.resolve();
  const emit = (event) => {
    const summary = summarizeEvent(event);
    eventWrite = eventWrite.then(() => persistEvents(projectId, runId, [summary])).catch(() => {});
    const capability = summary.capability;
    if (capability && !run.capabilities.granted.includes(capability) && !control.violation) {
      control.violation = new HarnessRuntimeError(403, 'CAPABILITY_DENIED', `Harness tool capability denied: ${capability}.`, { capability, tool: summary.name || summary.tool });
      control.controller.abort(control.violation);
    }
  };

  try {
    await copyWorkspace(projectRoot, workspace);
    if (Array.isArray(request.researchSkills)) {
      const removedSkillPaths = await restrictWorkspaceResearchSkills(workspace, { enabledSkillNames: request.researchSkills });
      const bundledSkillPaths = await copyBundledResearchSkills(workspace, { enabledSkillNames: request.researchSkills });
      excludedSkillPaths = [...removedSkillPaths, ...bundledSkillPaths];
    }
    const task = adapter.run({
      request: { ...request, contextPack: run.contextPack },
      projectRoot,
      workspace,
      dshHome,
      capabilities: run.capabilities.granted,
      capabilityPolicy: run.capabilities,
      signal: control.controller.signal,
      emit
    });
    const result = await runWithTimeout(task, run.limits.timeoutMs, control.controller);
    await eventWrite;
    const workspacePatches = run.adapter === 'deepseek'
      ? await collectPatches(projectRoot, workspace, run.capabilities, excludedSkillPaths)
      : [];
    const patches = [...patchListFromResult(result, run.capabilities), ...workspacePatches]
      .filter((patch, index, values) => values.findIndex((item) => item.path === patch.path) === index);
    const updated = await updateRun(projectId, runId, (current) => {
      current.status = 'completed';
      current.finishedAt = now();
      current.updatedAt = current.finishedAt;
      current.reply = result?.finalResponse || result?.reply || '';
      current.sessionId = result?.sessionId;
      current.patches = patches;
      current.humanDecision = patches.length ? { status: 'pending' } : { status: 'none' };
      current.output = result?.output;
      current.tokenUsage = result?.usage || result?.tokenUsage || current.events.map((event) => event.usage).find(Boolean) || null;
      current.adapterResult = { ok: result?.ok !== false, fallback: current.fallback || false };
      return current;
    });
    pendingRequests.delete(runId);
    return updated;
  } catch (error) {
    await eventWrite;
    const runtimeError = control.violation || control.timeoutError || asRuntimeError(error);
    if (control.cancelRequested || control.controller.signal.reason?.code === 'HARNESS_CANCELLED') {
      return updateRun(projectId, runId, (current) => {
        current.status = 'cancelled';
        current.finishedAt = now();
        current.updatedAt = current.finishedAt;
        current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
        return current;
      });
    }
    if (control.pauseRequested || control.controller.signal.reason?.code === 'HARNESS_PAUSED') {
      return updateRun(projectId, runId, (current) => {
        current.status = 'paused';
        current.updatedAt = now();
        current.error = { code: 'HARNESS_PAUSED', message: 'Harness Run was paused and can be resumed.', retryable: true };
        return current;
      });
    }

    if (run.adapter === 'deepseek' && run.fallback && runtimeError.retryable && !runtimeError.code?.includes('CAPABILITY') && !runtimeError.code?.includes('PATH')) {
      const fallbackAdapter = adapters.get('legacy');
      try {
        emit({ type: 'runtime/fallback', data: { from: 'deepseek', to: 'legacy', error: runtimeError.message } });
        const fallbackResult = await runWithTimeout(fallbackAdapter.run({
          request: { ...request, contextPack: run.contextPack },
          projectRoot,
          workspace,
          dshHome,
          capabilities: run.capabilities.granted,
          capabilityPolicy: run.capabilities,
          signal: control.controller.signal,
          emit
        }), run.limits.timeoutMs, control.controller);
        await eventWrite;
        const patches = patchListFromResult(fallbackResult, run.capabilities);
        const updated = await updateRun(projectId, runId, (current) => {
          current.status = 'completed';
          current.finishedAt = now();
          current.updatedAt = current.finishedAt;
          current.adapter = 'legacy';
          current.adapterHistory = [...(current.adapterHistory || []), { adapter: 'deepseek', error: runtimeError.message, at: now() }];
          current.reply = fallbackResult?.finalResponse || fallbackResult?.reply || '';
          current.sessionId = fallbackResult?.sessionId;
          current.patches = patches;
          current.humanDecision = patches.length ? { status: 'pending' } : { status: 'none' };
          current.fallback = true;
          current.error = { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable };
          current.adapterResult = { ok: true, fallback: true };
          return current;
        });
        pendingRequests.delete(runId);
        return updated;
      } catch (fallbackError) {
        const fallbackRuntimeError = asRuntimeError(fallbackError, 'FALLBACK_FAILED');
        return updateRun(projectId, runId, (current) => {
          current.status = 'failed';
          current.finishedAt = now();
          current.updatedAt = current.finishedAt;
          current.error = { code: fallbackRuntimeError.code, message: fallbackRuntimeError.message, retryable: fallbackRuntimeError.retryable };
          current.harnessError = runtimeError.message;
          return current;
        });
      }
    }

    return updateRun(projectId, runId, (current) => {
      current.status = 'failed';
      current.finishedAt = now();
      current.updatedAt = current.finishedAt;
      current.error = { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable };
      return current;
    });
  } finally {
    pendingRequests.delete(runId);
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function createHarnessRun(projectId, request = {}) {
  const projectRoot = await resolveHarnessProjectRoot(projectId);
  const constraints = await readProjectConstraints(projectRoot);
  const configuredCapabilities = constraints.capabilities || DEFAULT_PROJECT_CAPABILITIES;
  const requestedCapabilities = request.capabilities;
  const capabilities = applyProjectConstraintPolicy(
    resolveCapabilityPolicy({ requested: requestedCapabilities, configured: configuredCapabilities }),
    constraints
  );
  const adapter = normalizeAdapter(request.adapter || request.runtime || request.llmConfig?.runtime || getEnv('AGENT_RUNTIME'));
  const contextPack = await buildContextPack({
    projectId,
    projectRoot,
    request: { ...request, adapter },
    policy: capabilities,
    constraints
  });
  const createdAt = now();
  const run = {
    schemaVersion: 1,
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
    model: request.llmConfig?.model || getEnv('HARNESS_MODEL') || process.env.DEEPSEEK_MODEL || (adapter === 'deepseek' ? 'deepseek-flash' : null),
    skills: Array.isArray(request.researchSkills) ? request.researchSkills : [],
    contextHash: contextPack.contextHash,
    contextManifest: contextManifest(contextPack),
    contextPack,
    capabilities,
    limits: buildLimits(request, capabilities),
    fallback: request.fallback !== false && getEnv('HARNESS_FALLBACK') !== 'false' && capabilities.constraints?.fallback !== false,
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
    document.runs = [run, ...document.runs].slice(0, 100);
    await writeHarnessRuns(projectRoot, document);
  });
  pendingRequests.set(run.id, { ...request, projectId, adapter });
  return clone(run);
}

export async function getHarnessRun(projectId, runId) {
  const { document } = await getRunDocument(projectId);
  const run = document.runs.find((item) => item.id === runId);
  if (!run) throw new HarnessRuntimeError(404, 'HARNESS_RUN_NOT_FOUND', 'Harness Run not found.', { runId });
  return clone(run);
}

export async function listHarnessRuns(projectId, { status, stage, limit = 50 } = {}) {
  const { document } = await getRunDocument(projectId);
  const max = numberOr(limit, 50, { min: 1, max: 100 });
  return document.runs
    .filter((run) => (!status || run.status === status) && (!stage || run.stage === stage))
    .slice(0, max)
    .map(clone);
}

export async function startHarnessRun(projectId, runId, { wait = false, request = {} } = {}) {
  const run = await getHarnessRun(projectId, runId);
  assertRunnableStatus(run);
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
  if (existing) return wait ? existing.promise : getHarnessRun(projectId, runId);
  if (activeCount(projectId) >= run.limits.maxConcurrent) {
    throw new HarnessRuntimeError(409, 'HARNESS_CONCURRENCY_LIMIT', 'Project Harness concurrency limit reached.', { maxConcurrent: run.limits.maxConcurrent });
  }
  const started = await updateRun(projectId, runId, (current) => {
    current.status = 'running';
    current.attempt += 1;
    current.startedAt = current.startedAt || now();
    current.updatedAt = now();
    current.error = null;
    return current;
  });
  const controller = new AbortController();
  const control = { controller, pauseRequested: false, cancelRequested: false, timeoutError: null, violation: null };
  const effectiveRequest = mergeRequest(started, request);
  const promise = executeRun(projectId, runId, effectiveRequest, control).finally(() => activeRuns.delete(runId));
  activeRuns.set(runId, { projectId, controller, control, promise });
  return wait ? promise : started;
}

export async function waitForHarnessRun(projectId, runId) {
  const active = activeRuns.get(runId);
  return active ? active.promise : getHarnessRun(projectId, runId);
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
      if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
      current.status = 'cancelled';
      current.finishedAt = now();
      current.updatedAt = current.finishedAt;
      current.error = { code: 'HARNESS_CANCELLED', message: 'Harness Run was cancelled.', retryable: false };
      return current;
    });
  }
  active.control.cancelRequested = true;
  active.controller.abort(Object.assign(new Error('Harness Run cancelled.'), { code: 'HARNESS_CANCELLED' }));
  return active.promise;
}

export async function replayHarnessRun(projectId, runId, { request = {}, start = true } = {}) {
  const original = await getHarnessRun(projectId, runId);
  const run = await createHarnessRun(projectId, { ...original.request, ...request, stage: original.stage, task: original.task, replayOf: original.id });
  return start ? startHarnessRun(projectId, run.id, { wait: true, request }) : run;
}

export async function decideHarnessRun(projectId, runId, { decision, actor = 'human', note = '' } = {}) {
  if (!['accept', 'reject'].includes(decision)) throw new HarnessRuntimeError(400, 'INVALID_HUMAN_DECISION', 'decision must be accept or reject.');
  return updateRun(projectId, runId, (run) => {
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new HarnessRuntimeError(409, 'HARNESS_RUN_NOT_DECIDABLE', 'Only a finished Harness Run can receive a human decision.');
    }
    run.humanDecision = { status: decision === 'accept' ? 'accepted' : 'rejected', actor: String(actor), note: String(note || ''), at: now() };
    run.updatedAt = now();
    return run;
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
  const run = await createHarnessRun(request.projectId, request);
  const result = await startHarnessRun(request.projectId, run.id, { wait: true });
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
