import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { assertProjectId } from '../researchWorkflow/errors.js';
import { ExperimentRunnerError } from './errors.js';

export const EXPERIMENT_RUNS_FILE = path.join('.scienceprism', 'experiment-runs.json');
export const EXPERIMENT_RUNS_DIRECTORY = path.join('.scienceprism', 'experiment-runs');
const locks = new Map();

export async function resolveExperimentProjectRoot(projectId) {
  try {
    assertProjectId(projectId);
    return await getProjectRoot(projectId);
  } catch (error) {
    if (error instanceof ExperimentRunnerError) throw error;
    throw new ExperimentRunnerError(404, 'PROJECT_NOT_FOUND', 'Project not found.', { projectId });
  }
}

function emptyDocument(projectId) {
  return { schemaVersion: 1, projectId, version: 1, runs: [], updatedAt: new Date().toISOString() };
}

function runsPath(projectRoot) { return path.join(projectRoot, EXPERIMENT_RUNS_FILE); }

export async function readExperimentRuns(projectRoot, projectId) {
  try {
    const value = JSON.parse(await fs.readFile(runsPath(projectRoot), 'utf8'));
    if (value?.schemaVersion !== 1 || value.projectId !== projectId || !Array.isArray(value.runs)) {
      throw new ExperimentRunnerError(500, 'EXPERIMENT_RUNS_CORRUPT', 'Experiment Run storage has an unsupported shape.');
    }
    return value;
  } catch (error) {
    if (error instanceof ExperimentRunnerError) throw error;
    if (error?.code === 'ENOENT') return emptyDocument(projectId);
    if (error instanceof SyntaxError) throw new ExperimentRunnerError(500, 'EXPERIMENT_RUNS_CORRUPT', 'Experiment Run storage is not valid JSON.');
    throw error;
  }
}

export async function writeExperimentRuns(projectRoot, document) {
  const directory = path.dirname(runsPath(projectRoot));
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.experiment-runs.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporary, runsPath(projectRoot));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function runDirectory(projectRoot, runId) {
  return path.join(projectRoot, EXPERIMENT_RUNS_DIRECTORY, runId);
}

export function artifactDirectory(projectRoot, runId) {
  return path.join(runDirectory(projectRoot, runId), 'artifacts');
}

export async function withExperimentRunLock(projectId, callback) {
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
