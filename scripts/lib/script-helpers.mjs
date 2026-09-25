/**
 * Shared helpers for the scripts in this directory.
 *
 * loadDotEnv was copied verbatim into six scripts. A copy in every file means a
 * fix to one silently misses the others, which is why this exists.
 *
 * Kept deliberately small and dependency-free: the project must not gain one.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Applies .env into process.env.
 *
 * The project has no dotenv dependency and config/constants.js reads the
 * environment at import time, so .env has to be applied before any service
 * module is imported. Existing environment variables win, so a caller can
 * override. A missing file is not an error: scripts run fine without it.
 */
export async function loadDotEnv(repoRoot) {
  let text = '';
  try {
    text = await fs.readFile(path.join(repoRoot, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

/** FNV-style hash, used to sample deterministically without carrying a PRNG. */
export function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Sorts items by a seeded hash so the same seed gives the same subset, without
 * depending on a random number generator.
 */
export function sampleByHash(items, seed, keyOf, limit) {
  return items
    .map((item, index) => ({ item, index, key: hash(`${seed}:${keyOf(item, index)}`) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit)
    .map((entry) => entry.item);
}
