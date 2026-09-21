import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';

const locks = new Map();

export const HUB_DIRECTORY = '.scienceprism';

export async function resolveHubProjectRoot(projectId) {
  return getProjectRoot(projectId);
}

export async function readHubJson(projectId, filename, fallback) {
  const root = await resolveHubProjectRoot(projectId);
  const filePath = path.join(root, HUB_DIRECTORY, filename);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : fallback;
    if (error instanceof SyntaxError) throw new Error(`${filename} is not valid JSON.`);
    throw error;
  }
}

export async function writeHubJson(projectId, filename, value) {
  const root = await resolveHubProjectRoot(projectId);
  const directory = path.join(root, HUB_DIRECTORY);
  const filePath = path.join(directory, filename);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withHubLock(projectId, callback) {
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

