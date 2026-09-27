import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../projectService.js';
import { readHubJson, withHubLock, writeHubJson } from '../projectHub/repository.js';
import { CONSTRAINT_REGISTRY, getConstraint } from './index.js';

export const CONSTRAINT_POLICY_FILE = 'constraint-policy.json';

export class ConstraintPolicyError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

/**
 * Normalises a Project's constraint policy.
 *
 * `core` constraints are product invariants (human authority, path safety,
 * default-read-only, evidence traceability), so a policy file cannot switch
 * them off: such an entry is rejected and reported rather than silently
 * honoured. Everything else is a per-project choice, which is what makes the
 * constraint set selectable without making it negotiable.
 */
export function normalizeConstraintPolicy(raw) {
  const requested = uniqueStrings(raw?.disabled);
  const rejected = [];
  const disabled = [];

  for (const id of requested) {
    const constraint = getConstraint(id);
    if (!constraint) {
      rejected.push({ id, reason: 'UNKNOWN_CONSTRAINT' });
      continue;
    }
    if (constraint.tier === 'core') {
      rejected.push({ id, reason: 'CORE_CONSTRAINT_IMMUTABLE' });
      continue;
    }
    disabled.push(id);
  }

  const enabled = CONSTRAINT_REGISTRY
    .filter((constraint) => !disabled.includes(constraint.id))
    .map((constraint) => constraint.id);

  return {
    disabled,
    enabled,
    rejected,
    preset: typeof raw?.preset === 'string' && raw.preset.trim() ? raw.preset.trim() : 'standard',
    audit: Array.isArray(raw?.audit) ? raw.audit : []
  };
}

export function isConstraintEnabled(policy, id) {
  const normalized = policy || normalizeConstraintPolicy(null);
  return normalized.enabled.includes(id);
}

/** Reads the Project's policy file; an absent file means every constraint stays on. */
export async function readConstraintPolicy(projectId) {
  const root = await getProjectRoot(projectId);
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, '.scienceprism', CONSTRAINT_POLICY_FILE), 'utf8'));
    return normalizeConstraintPolicy(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeConstraintPolicy(null);
    if (error instanceof SyntaxError) {
      return { ...normalizeConstraintPolicy(null), rejected: [{ id: null, reason: 'CONSTRAINT_POLICY_UNREADABLE' }] };
    }
    throw error;
  }
}

/** A human decision is stored atomically and the runtime reads the same file. */
export async function setConstraintEnabled(projectId, id, enabled, { actor } = {}) {
  if (actor !== 'human') throw new ConstraintPolicyError(403, 'HUMAN_DECISION_REQUIRED', 'Only a human may change a project constraint.');
  if (typeof enabled !== 'boolean') throw new ConstraintPolicyError(400, 'INVALID_ENABLED', 'enabled must be a boolean.');
  const constraint = getConstraint(id);
  if (!constraint) throw new ConstraintPolicyError(404, 'UNKNOWN_CONSTRAINT', 'Unknown constraint.');
  if (constraint.tier === 'core') throw new ConstraintPolicyError(403, 'CORE_CONSTRAINT_IMMUTABLE', 'Core constraints cannot be disabled.');
  return withHubLock(projectId, async () => {
    const raw = await readHubJson(projectId, CONSTRAINT_POLICY_FILE, () => ({}));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConstraintPolicyError(500, 'CONSTRAINT_POLICY_UNREADABLE', 'Constraint policy is malformed.');
    const current = normalizeConstraintPolicy(raw);
    const disabled = new Set(current.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    const next = {
      preset: current.preset,
      disabled: [...disabled],
      audit: [...current.audit, { id, action: enabled ? 'enable' : 'disable', actor, at: new Date().toISOString() }]
    };
    await writeHubJson(projectId, CONSTRAINT_POLICY_FILE, next);
    return constraintPolicyProjection(normalizeConstraintPolicy(next));
  });
}

/**
 * Projects the effective policy for display. A disabled constraint keeps its
 * entry so the UI can show what was switched off, rather than hiding it.
 */
export function constraintPolicyProjection(policy) {
  const normalized = policy || normalizeConstraintPolicy(null);
  return {
    preset: normalized.preset,
    disabled: [...normalized.disabled],
    rejected: normalized.rejected.map((entry) => ({ ...entry })),
    audit: normalized.audit.map((entry) => ({ ...entry })),
    constraints: CONSTRAINT_REGISTRY.map((constraint) => ({
      id: constraint.id,
      statement: constraint.statement,
      tier: constraint.tier,
      canToggle: constraint.tier !== 'core',
      enabled: normalized.enabled.includes(constraint.id)
    }))
  };
}
