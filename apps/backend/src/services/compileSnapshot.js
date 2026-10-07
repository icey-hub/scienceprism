import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { safeJoin } from '../utils/pathUtils.js';
import { isSensitivePath } from './harnessRuntime/capabilities.js';

function invalidInput(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Record the bytes copied for this invocation, not an atomic project revision. */
export async function copyCompileInputs(projectRoot, inputRoot, { runId, mainFile, engine }) {
  if (typeof mainFile !== 'string' || !mainFile || mainFile.startsWith('-') ||
      /[\\\x00-\x1f]/.test(mainFile) || path.posix.normalize(mainFile) !== mainFile ||
      path.posix.isAbsolute(mainFile) || mainFile.split('/').includes('..')) {
    throw invalidInput('Invalid main file path.');
  }
  const files = [];
  await fs.mkdir(inputRoot, { recursive: true });
  async function copy(relative = '') {
    const directory = relative ? safeJoin(projectRoot, relative) : projectRoot;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === '.compile' || entry.name === 'project.json' || isSensitivePath(name)) continue;
      const source = safeJoin(projectRoot, name);
      const target = safeJoin(inputRoot, name);
      if (entry.isDirectory()) {
        await fs.mkdir(target, { recursive: true });
        await copy(name);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(source);
        await fs.writeFile(target, bytes);
        files.push({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } else {
        throw invalidInput(`Unsupported compile input (symbolic link or special file): ${name}`);
      }
    }
  }
  await copy();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some(file => file.path === mainFile)) throw invalidInput('Main file is missing or excluded from compilation.');
  const manifest = { mainFile, engine, files };
  return { runId, ...manifest, hash: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}
