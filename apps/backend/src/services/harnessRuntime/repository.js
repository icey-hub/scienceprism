import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { assertProjectId } from '../researchWorkflow/errors.js';
import { HarnessRuntimeError } from './errors.js';

export const HARNESS_RUNS_FILE = path.join('.scienceprism', 'harness-runs.json');
const locks = new Map();

export async function resolveHarnessProjectRoot(projectId) {
  try {
    assertProjectId(projectId);
  } catch (error) {
    throw new HarnessRuntimeError(400, 'INVALID_PROJECT_ID', error?.message || 'Invalid project id.');
  }
  try {
    return await getProjectRoot(projectId);
  } catch {
    throw new HarnessRuntimeError(404, 'PROJECT_NOT_FOUND', 'Project not found.', { projectId });
  }
}

function emptyDocument(projectId) {
  return { schemaVersion: 1, projectId, runs: [] };
}

function runsPath(projectRoot) {
  return path.join(projectRoot, HARNESS_RUNS_FILE);
}

export async function readHarnessRuns(projectRoot, projectId) {
  try {
    const value = JSON.parse(await fs.readFile(runsPath(projectRoot), 'utf8'));
    if (value?.schemaVersion !== 1 || value.projectId !== projectId || !Array.isArray(value.runs)) {
      throw new HarnessRuntimeError(500, 'HARNESS_RUNS_CORRUPT', 'Harness Run storage has an unsupported shape.');
    }
    return value;
  } catch (error) {
    if (error instanceof HarnessRuntimeError) throw error;
    if (error?.code === 'ENOENT') return emptyDocument(projectId);
    if (error instanceof SyntaxError) throw new HarnessRuntimeError(500, 'HARNESS_RUNS_CORRUPT', 'Harness Run storage is not valid JSON.');
    throw error;
  }
}

export async function writeHarnessRuns(projectRoot, document) {
  const directory = path.dirname(runsPath(projectRoot));
  await fs.mkdir(directory, { recursive: true });
  const target = runsPath(projectRoot);
  const temporary = path.join(directory, `.harness-runs.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withHarnessRunLock(projectId, callback) {
  const previous = locks.get(projectId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(projectId, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(projectId) === current) locks.delete(projectId);
  }
}

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
