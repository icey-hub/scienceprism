import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { EvidenceLedgerError } from './errors.js';
import { evidenceLedgerSchema, normalizeEvidenceRecord, normalizeEvidenceRelation } from './schema.js';

export const EVIDENCE_LEDGER_FILE = path.join('.scienceprism', 'evidence-ledger.json');
export const LEGACY_EVIDENCE_FILES = Object.freeze([
  path.join('.scienceprism', 'evidence.json'),
  path.join('.openprism', 'evidence-ledger.json'),
  path.join('.openprism', 'evidence.json')
]);
const locks = new Map();

function now() {
  return new Date().toISOString();
}

function emptyLedger(projectId) {
  return { schemaVersion: 1, projectId, version: 1, entries: [], relations: [], updatedAt: now() };
}

function ledgerPath(projectRoot) {
  return path.join(projectRoot, EVIDENCE_LEDGER_FILE);
}

async function findLedgerPath(projectRoot) {
  for (const relativePath of [EVIDENCE_LEDGER_FILE, ...LEGACY_EVIDENCE_FILES]) {
    try {
      await fs.access(path.join(projectRoot, relativePath));
      return path.join(projectRoot, relativePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return ledgerPath(projectRoot);
}

function migrateLedger(value, projectId) {
  const input = Array.isArray(value) ? { entries: value } : value && typeof value === 'object' ? value : {};
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const relations = Array.isArray(input.relations) ? input.relations : Array.isArray(input.relationships) ? input.relationships : [];
  const timestamp = input.updatedAt || now();
  const normalizedRelations = [];
  for (const relation of relations) {
    try {
      normalizedRelations.push(normalizeEvidenceRelation(relation, { now: timestamp }));
    } catch {
      // Legacy ledgers may contain relationship labels that are not part of the canonical graph.
    }
  }
  const migrated = {
    schemaVersion: 1,
    projectId,
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    entries: entries.map((entry) => normalizeEvidenceRecord(entry, { now: timestamp })),
    relations: normalizedRelations,
    updatedAt: timestamp
  };
  return evidenceLedgerSchema.parse(migrated);
}

export async function resolveEvidenceProjectRoot(projectId) {
  try {
    return await getProjectRoot(projectId);
  } catch {
    throw new EvidenceLedgerError(404, 'PROJECT_NOT_FOUND', 'Project not found.', { projectId });
  }
}

export async function readEvidenceLedger(projectRoot, projectId) {
  const storedPath = await findLedgerPath(projectRoot);
  try {
    const value = JSON.parse(await fs.readFile(storedPath, 'utf8'));
    const ledger = migrateLedger(value, projectId);
    if (storedPath !== ledgerPath(projectRoot)) await writeEvidenceLedger(projectRoot, ledger);
    return ledger;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger(projectId);
    if (error instanceof SyntaxError || error?.name === 'ZodError') {
      throw new EvidenceLedgerError(500, 'EVIDENCE_LEDGER_CORRUPT', 'Evidence Ledger is not valid or has an unsupported shape.');
    }
    throw error;
  }
}

export async function writeEvidenceLedger(projectRoot, ledger) {
  const target = ledgerPath(projectRoot);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.evidence-ledger.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withEvidenceLedgerLock(projectId, callback) {
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
