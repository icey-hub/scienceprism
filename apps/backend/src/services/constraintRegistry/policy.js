import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../projectService.js';
import { CONSTRAINT_REGISTRY, getConstraint } from './index.js';

export const CONSTRAINT_POLICY_FILE = 'constraint-policy.json';

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
    preset: typeof raw?.preset === 'string' && raw.preset.trim() ? raw.preset.trim() : 'standard'
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
    constraints: CONSTRAINT_REGISTRY.map((constraint) => ({
      id: constraint.id,
      tier: constraint.tier,
      enabled: normalized.enabled.includes(constraint.id)
    }))
  };
}
