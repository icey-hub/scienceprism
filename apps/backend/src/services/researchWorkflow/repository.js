import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../projectService.js';
import { assertProjectId, ResearchWorkflowError } from './errors.js';
import { clone } from './audit.js';
import { migrateStoredWorkflow, validateStoredWorkflow, RESEARCH_WORKFLOW_SCHEMA_VERSION } from './migrations.js';

export const RESEARCH_WORKFLOW_FILE = path.join('.scienceprism', 'research-workflow.json');
export const LEGACY_RESEARCH_WORKFLOW_FILE = path.join('.openprism', 'research-workflow.json');
const locks = new Map();

export async function resolveProjectRoot(projectId) {
  assertProjectId(projectId);
  try {
    return await getProjectRoot(projectId);
  } catch {
    throw new ResearchWorkflowError(404, 'PROJECT_NOT_FOUND', 'Project not found.', { projectId });
  }
}

export function workflowPath(projectRoot) {
  return path.join(projectRoot, RESEARCH_WORKFLOW_FILE);
}

async function existingWorkflowPath(projectRoot) {
  for (const relativePath of [RESEARCH_WORKFLOW_FILE, LEGACY_RESEARCH_WORKFLOW_FILE]) {
    const candidate = path.join(projectRoot, relativePath);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return workflowPath(projectRoot);
}

export async function readWorkflowFile(projectRoot, projectId) {
  try {
    const storedPath = await existingWorkflowPath(projectRoot);
    const raw = await fs.readFile(storedPath, 'utf8');
    const { workflow, migrated } = migrateStoredWorkflow(JSON.parse(raw), projectId);
    validateStoredWorkflow(workflow, projectId);
    if (migrated || storedPath !== workflowPath(projectRoot)) await writeWorkflowFile(projectRoot, workflow);
    return workflow;
  } catch (error) {
    if (error instanceof ResearchWorkflowError) throw error;
    if (error?.code === 'ENOENT') throw new ResearchWorkflowError(404, 'WORKFLOW_NOT_FOUND', 'Research workflow has not been initialized.');
    if (error instanceof SyntaxError) throw new ResearchWorkflowError(500, 'WORKFLOW_CORRUPT', 'Research workflow file is not valid JSON.');
    throw error;
  }
}

export async function writeWorkflowFile(projectRoot, workflow) {
  const directory = path.dirname(workflowPath(projectRoot));
  await fs.mkdir(directory, { recursive: true });
  const target = workflowPath(projectRoot);
  const temporary = path.join(directory, `.research-workflow.${process.pid}.${cryptoRandomId()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function withWorkflowLock(projectId, callback) {
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

export { clone, RESEARCH_WORKFLOW_SCHEMA_VERSION };

