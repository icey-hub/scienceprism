import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { safeJoin } from '../../utils/pathUtils.js';

export const contentHash = (content) => createHash('sha256').update(content).digest('hex');
export const fileVersion = (content) => content === null
  ? { exists: false, sha256: null }
  : { exists: true, sha256: contentHash(content) };
export const sameVersion = (left, right) => Boolean(left && right
  && left.exists === right.exists && left.sha256 === right.sha256);

export async function readFileState(root, relativePath) {
  try {
    const content = await fs.readFile(safeJoin(root, relativePath), 'utf8');
    return { content, ...fileVersion(content) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { content: '', ...fileVersion(null) };
  }
}
