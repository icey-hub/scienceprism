import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isSensitivePath } from '../harnessRuntime/capabilities.js';
import { ExperimentRunnerError } from './errors.js';

export const RUNNER_VERSION = '1';
export const EXPERIMENT_ADAPTERS = Object.freeze(['node', 'fake']);
export const ARTIFACT_KINDS = Object.freeze(['log', 'metric', 'chart', 'table', 'checkpoint', 'environment', 'output']);
const MAX_SNAPSHOT_FILES = 2_000;
const MAX_SNAPSHOT_FILE_BYTES = 25 * 1024 * 1024;

function now() { return new Date().toISOString(); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function normalizeRelativePath(value, field) {
  const raw = text(value).replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new ExperimentRunnerError(400, 'INVALID_MANIFEST', `${field} must be a project-relative path.`);
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || isSensitivePath(normalized)) throw new ExperimentRunnerError(400, 'INVALID_MANIFEST', `${field} points outside the experiment project or to a sensitive path.`);
  return normalized;
}

function normalizeExecution(value) {
  if (!plainObject(value)) return null;
  const adapter = text(value.adapter || value.runner).toLowerCase();
  if (!EXPERIMENT_ADAPTERS.includes(adapter)) throw new ExperimentRunnerError(400, 'INVALID_EXECUTION_ADAPTER', `Unsupported Experiment Runner Adapter: ${adapter || '(missing)'}.`);
  const args = Array.isArray(value.args) ? value.args.map((item) => String(item)) : [];
  if (args.some((item) => item.includes('\u0000') || item.length > 2_000) || args.length > 100) throw new ExperimentRunnerError(400, 'INVALID_EXECUTION_ARGS', 'Experiment arguments are invalid or exceed the limit.');
  if (adapter === 'fake') return { adapter, args };
  const entrypoint = normalizeRelativePath(value.entrypoint, 'execution.entrypoint');
  if (!/\.(?:c|m)?js$/i.test(entrypoint)) throw new ExperimentRunnerError(400, 'INVALID_EXECUTION_ENTRYPOINT', 'The Node Adapter requires a .js, .mjs, or .cjs entrypoint.');
  return { adapter, entrypoint, args };
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 100) throw new ExperimentRunnerError(400, 'INVALID_ARTIFACT_DECLARATIONS', 'An Experiment Run may declare at most 100 artifacts.');
  return value.map((item, index) => {
    if (typeof item === 'string') return { path: normalizeRelativePath(item, `artifacts[${index}]`), kind: 'output', name: path.posix.basename(item) };
    if (!plainObject(item)) throw new ExperimentRunnerError(400, 'INVALID_ARTIFACT_DECLARATION', `Artifact declaration ${index + 1} must be an object.`);
    const relativePath = normalizeRelativePath(item.path, `artifacts[${index}].path`);
    const kind = text(item.kind || 'output').toLowerCase();
    if (!ARTIFACT_KINDS.includes(kind)) throw new ExperimentRunnerError(400, 'INVALID_ARTIFACT_KIND', `Unsupported artifact kind: ${kind}.`);
    return { path: relativePath, kind, name: text(item.name) || path.posix.basename(relativePath) };
  });
}

async function listFiles(root, relative = '') {
  if (relative && isSensitivePath(relative)) return [];
  let entries;
  try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
    if (isSensitivePath(child) || ['node_modules', '.git'].includes(entry.name)) continue;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
    if (files.length >= MAX_SNAPSHOT_FILES) break;
  }
  return files.slice(0, MAX_SNAPSHOT_FILES);
}

async function hashFile(root, relativePath) {
  const absolute = path.join(root, relativePath);
  const stat = await fs.stat(absolute);
  if (stat.size > MAX_SNAPSHOT_FILE_BYTES) return { path: relativePath, bytes: stat.size, skipped: 'size-limit' };
  const hash = createHash('sha256');
  hash.update(await fs.readFile(absolute));
  return { path: relativePath, bytes: stat.size, sha256: hash.digest('hex') };
}

export async function snapshotExperimentCode(root, codePaths = []) {
  const normalizedPaths = codePaths.map((item) => normalizeRelativePath(item, 'codePaths[]'));
  const requested = normalizedPaths.length ? normalizedPaths : await listFiles(root);
  const files = [];
  for (const relativePath of [...new Set(requested)]) {
    try {
      const stat = await fs.stat(path.join(root, relativePath));
      if (stat.isDirectory()) {
        const nested = await listFiles(root, relativePath);
        for (const item of nested) files.push(await hashFile(root, item));
      } else if (stat.isFile()) files.push(await hashFile(root, relativePath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (files.length >= MAX_SNAPSHOT_FILES) break;
  }
  const sorted = files.slice(0, MAX_SNAPSHOT_FILES).sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash('sha256').update(sorted.map((item) => `${item.path}:${item.sha256 || item.skipped}`).join('\n')).digest('hex');
  return { hash, files: sorted, paths: normalizedPaths };
}

export async function assertExperimentCodeSnapshot(root, manifest) {
  const current = await snapshotExperimentCode(root, manifest.code?.paths || []);
  if (current.hash === manifest.code?.snapshotHash) return current;
  const recordedFiles = new Map((manifest.code?.files || []).map((file) => [file.path, file.sha256 || file.skipped]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file.sha256 || file.skipped]));
  const changedPaths = [...new Set([...recordedFiles.keys(), ...currentFiles.keys()])]
    .filter((filePath) => recordedFiles.get(filePath) !== currentFiles.get(filePath))
    .sort()
    .slice(0, 100);
  throw new ExperimentRunnerError(409, 'EXPERIMENT_CODE_CHANGED', 'Project code changed after the Experiment Run Manifest was created. Create or retry the Run to record a new snapshot.', {
    recordedSnapshotHash: manifest.code?.snapshotHash || null,
    currentSnapshotHash: current.hash,
    changedPaths
  });
}

async function fileHashIfPresent(root, relativePath) {
  try { return (await hashFile(root, relativePath)).sha256 || null; } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function buildExperimentManifest(projectId, runId, input = {}, projectRoot) {
  const source = plainObject(input.plan) ? input.plan : plainObject(input.experiment) ? input.experiment : input;
  const datasetValue = plainObject(source.dataset) ? source.dataset : { id: source.dataset || source.datasetId, version: source.datasetVersion || source.version };
  const datasetId = text(datasetValue.id);
  const datasetVersion = text(datasetValue.version);
  const protocol = text(source.protocol || source.description);
  if (!datasetId || !datasetVersion || !protocol) throw new ExperimentRunnerError(400, 'INVALID_MANIFEST', 'Experiment Run requires dataset, dataset version, and protocol.');
  const execution = normalizeExecution(source.execution || source.commandSpec);
  if (!execution) throw new ExperimentRunnerError(400, 'EXECUTION_SPEC_REQUIRED', 'A structured execution spec is required. A free-form command is only a plan note and cannot be executed.');
  if (execution.adapter === 'fake' && process.env.NODE_ENV !== 'test' && process.env.SCIENCEPRISM_ALLOW_EXPERIMENT_FAKE !== 'true') {
    throw new ExperimentRunnerError(403, 'FAKE_ADAPTER_DISABLED', 'The Fake Experiment Runner Adapter is only available in tests.');
  }
  const snapshot = await snapshotExperimentCode(projectRoot, Array.isArray(source.codePaths) ? source.codePaths : []);
  const codeVersion = text(source.codeVersion) || `workspace:${snapshot.hash}`;
  const parameters = plainObject(source.parameters) ? source.parameters : {};
  const successCriteria = Array.isArray(source.successCriteria) ? source.successCriteria.map(String).filter(Boolean) : [];
  const resources = {
    timeoutMs: Math.min(Math.max(Number(source.resources?.timeoutMs) || 10 * 60 * 1000, 100), 24 * 60 * 60 * 1000),
    maxOutputBytes: Math.min(Math.max(Number(source.resources?.maxOutputBytes) || 2 * 1024 * 1024, 1_024), 50 * 1024 * 1024),
    maxArtifactBytes: Math.min(Math.max(Number(source.resources?.maxArtifactBytes) || 50 * 1024 * 1024, 1_024), 500 * 1024 * 1024)
  };
  const seed = source.seed === undefined || source.seed === null ? null : String(source.seed);
  return {
    schemaVersion: 1,
    id: runId,
    projectId,
    planId: text(source.planId) || null,
    code: { version: codeVersion, snapshotHash: snapshot.hash, files: snapshot.files, paths: snapshot.paths },
    dataset: { id: datasetId, version: datasetVersion, evidenceId: text(datasetValue.evidenceId) || null },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      runner: `scienceprism-experiment-runner/${RUNNER_VERSION}`,
      packageLockSha256: await fileHashIfPresent(projectRoot, 'package-lock.json')
    },
    command: { adapter: execution.adapter, ...(execution.entrypoint ? { entrypoint: execution.entrypoint } : {}), args: execution.args },
    commandNote: text(source.command),
    permissions: {
      plan: 'recorded',
      approval: 'human-required',
      execution: 'human-approval-and-project-capability',
      archive: 'runner-owned',
      interpretation: 'source-artifact-bound'
    },
    protocol,
    parameters,
    seed,
    resources,
    successCriteria,
    artifacts: normalizeArtifacts(source.artifacts || source.artifactPaths),
    createdAt: now()
  };
}

export function manifestSummary(manifest) {
  return {
    id: manifest.id,
    planId: manifest.planId,
    codeVersion: manifest.code.version,
    codeSnapshotHash: manifest.code.snapshotHash,
    dataset: manifest.dataset,
    environment: manifest.environment,
    command: manifest.command,
    parameters: manifest.parameters,
    seed: manifest.seed,
    resources: manifest.resources,
    successCriteria: manifest.successCriteria,
    artifacts: manifest.artifacts
  };
}

export { normalizeRelativePath };
