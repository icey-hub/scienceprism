import { CONSTRAINT_REGISTRY, CONSTRAINT_TIERS, DRIFTED_CONSTRAINTS, UNTESTED_CONSTRAINTS } from './constraints.js';

export { CONSTRAINT_REGISTRY, CONSTRAINT_TIERS, DRIFTED_CONSTRAINTS, UNTESTED_CONSTRAINTS };
export {
  CONSTRAINT_POLICY_FILE,
  constraintPolicyProjection,
  isConstraintEnabled,
  normalizeConstraintPolicy,
  readConstraintPolicy
} from './policy.js';

/**
 * Read projections over the constraint registry.
 *
 * Nothing here enforces anything yet: the registry is descriptive so the
 * catalogue can be projected, audited, and tested before any enforcement path
 * starts depending on it.
 */
export function listConstraints({ tier } = {}) {
  if (!tier) return [...CONSTRAINT_REGISTRY];
  return CONSTRAINT_REGISTRY.filter((constraint) => constraint.tier === tier);
}

export function getConstraint(id) {
  return CONSTRAINT_REGISTRY.find((constraint) => constraint.id === id) || null;
}

/** Machine-readable summary used by tests, the board, and the audit document. */
export function constraintCatalog() {
  const byTier = Object.fromEntries(CONSTRAINT_TIERS.map((tier) => [tier, 0]));
  const byProvenance = {};
  for (const constraint of CONSTRAINT_REGISTRY) {
    byTier[constraint.tier] = (byTier[constraint.tier] || 0) + 1;
    byProvenance[constraint.provenance.source] = (byProvenance[constraint.provenance.source] || 0) + 1;
  }
  return {
    total: CONSTRAINT_REGISTRY.length,
    byTier,
    byProvenance,
    tested: CONSTRAINT_REGISTRY.filter((constraint) => constraint.testRef !== null).length,
    untested: [...UNTESTED_CONSTRAINTS],
    drifted: [...DRIFTED_CONSTRAINTS]
  };
}

/**
 * Renders the human-facing table for `docs/project-constraints.md`, in that
 * document's own columns.
 *
 * That table used to be hand-written, with a gate comparing only the id sets, so
 * a row could describe a failure behaviour the code no longer had. It is now
 * generated from here and a gate fails when the committed file differs.
 */
export function renderConstraintTable() {
  const header = [
    '| ID | Constraint | Module | Validation location | Failure behaviour | State |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  const rows = CONSTRAINT_REGISTRY.map((constraint) => {
    const state = constraint.drift ? 'Drift' : 'Current';
    return `| ${constraint.id} | ${constraint.statement} | ${constraint.module} | ${constraint.validationLocation} | ${constraint.failure} | ${state} |`;
  });
  return [...header, ...rows].join('\n');
}

/**
 * Renders the machine-facing catalogue: tier, enforcement seam, test, provenance
 * and drift. Used by the audit, not by docs/project-constraints.md, which is
 * generated from renderConstraintTable().
 */
export function renderConstraintCatalog() {
  const header = [
    '| ID | Constraint | Tier | Enforced at | Test | Provenance | Drift |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  const rows = CONSTRAINT_REGISTRY.map((constraint) => {
    const location = `\`${constraint.enforcement.module}:${constraint.enforcement.symbol}\``;
    const test = constraint.testRef ? `\`${constraint.testRef.file}\`` : '**none**';
    const provenance = constraint.provenance.source === 'ai-subjective'
      ? '**ai-subjective**'
      : `${constraint.provenance.source}:${constraint.provenance.ref}`;
    return `| ${constraint.id} | ${constraint.statement} | ${constraint.tier} | ${location} | ${test} | ${provenance} | ${constraint.drift ? '**yes**' : '—'} |`;
  });
  return [...header, ...rows].join('\n');
}
