import path from 'path';
import { lstatSync } from 'fs';

export function assertStorageName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\\\\\x00-\x1f]/.test(name)) {
    const error = new Error('Invalid storage identifier');
    error.statusCode = 400;
    throw error;
  }
  return name;
}

export function safeJoin(root, targetPath) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, targetPath);
  if (!resolved.startsWith(base + path.sep)) {
    const error = new Error('Invalid path');
    error.statusCode = 400;
    throw error;
  }
  try {
    if (lstatSync(base).isSymbolicLink()) {
      const error = new Error('Invalid path');
      error.statusCode = 400;
      throw error;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // A lexical path can still escape through an existing symlink in the project.
  let current = base;
  for (const part of path.relative(base, resolved).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const error = new Error('Invalid path');
        error.statusCode = 400;
        throw error;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

export function sanitizeUploadPath(filename) {
  if (!filename) return '';
  const normalized = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/');
}
