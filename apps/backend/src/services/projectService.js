import { promises as fs } from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/constants.js';
import { assertStorageName } from '../utils/pathUtils.js';

export async function getProjectRoot(id) {
  const projectRoot = path.join(DATA_DIR, assertStorageName(id));
  if (!(await fs.lstat(projectRoot)).isDirectory()) {
    const error = new Error('Invalid project directory');
    error.statusCode = 400;
    throw error;
  }
  const metaPath = path.join(projectRoot, 'project.json');
  await fs.access(metaPath);
  return projectRoot;
}
