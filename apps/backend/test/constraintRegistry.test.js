import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', 'src');
const repoRoot = path.join(here, '..', '..', '..');

const {
  CONSTRAINT_REGISTRY,
  CONSTRAINT_TIERS,
  DRIFTED_CONSTRAINTS,
  UNTESTED_CONSTRAINTS,
  constraintCatalog,
  getConstraint,
  listConstraints,
  renderConstraintCatalog
} = await import('../src/services/constraintRegistry/index.js');

test('every registered constraint is well formed', () => {
  const ids = CONSTRAINT_REGISTRY.map((constraint) => constraint.id);
  assert.equal(new Set(ids).size, ids.length, 'constraint ids must be unique');

  for (const constraint of CONSTRAINT_REGISTRY) {
    assert.match(constraint.id, /^C-\d{2}$/, `unexpected id: ${constraint.id}`);
    assert.ok(constraint.statement.length > 20, `${constraint.id}: statement is too short to be a constraint`);
    assert.ok(CONSTRAINT_TIERS.includes(constraint.tier), `${constraint.id}: unknown tier ${constraint.tier}`);
    assert.ok(Array.isArray(constraint.scope) && constraint.scope.length > 0, `${constraint.id}: scope is required`);
    assert.ok(['adr', 'context', 'ai-subjective'].includes(constraint.provenance.source), `${constraint.id}: unknown provenance`);
    assert.ok(constraint.provenance.ref, `${constraint.id}: provenance must cite a decision or say why there is none`);
    assert.ok(
      constraint.drift === null || (typeof constraint.drift === 'string' && constraint.drift.length > 20),
      `${constraint.id}: drift must be null or an explanation of the doc/code gap`
    );
  }
});

test('every constraint points at an enforcement seam that really exists', async () => {
  for (const constraint of CONSTRAINT_REGISTRY) {
    const absolute = path.join(srcRoot, constraint.enforcement.module);
    const module = await import(absolute).catch((error) => {
      throw new Error(`${constraint.id}: cannot import ${constraint.enforcement.module} — ${error.message}`);
    });
    assert.notEqual(
      module[constraint.enforcement.symbol],
      undefined,
      `${constraint.id}: ${constraint.enforcement.module} does not export ${constraint.enforcement.symbol}`
    );
  }
});

test('every constraint test reference exists and names a real test', async () => {
  for (const constraint of CONSTRAINT_REGISTRY) {
    if (constraint.testRef === null) {
      assert.ok(
        UNTESTED_CONSTRAINTS.includes(constraint.id),
        `${constraint.id} has no test but is not declared in UNTESTED_CONSTRAINTS`
      );
      continue;
    }
    const source = await readFile(path.join(here, constraint.testRef.file), 'utf8');
    assert.ok(
      source.includes(`test('${constraint.testRef.name}'`),
      `${constraint.id}: ${constraint.testRef.file} has no test named "${constraint.testRef.name}"`
    );
  }

  // The untested set is locked so a new gap cannot appear unnoticed.
  const untested = CONSTRAINT_REGISTRY.filter((constraint) => constraint.testRef === null).map((constraint) => constraint.id);
  assert.deepEqual(untested.sort(), [...UNTESTED_CONSTRAINTS].sort());
});

test('the registry covers exactly the constraints the project documents', async () => {
  const documented = await readFile(path.join(repoRoot, 'docs', 'project-constraints.md'), 'utf8');
  const documentedIds = [...documented.matchAll(/^\|\s*(C-\d{2})\s*\|/gm)].map((match) => match[1]);
  assert.ok(documentedIds.length >= 16, `expected the catalogue table to list the constraints, found ${documentedIds.length}`);

  assert.deepEqual(
    CONSTRAINT_REGISTRY.map((constraint) => constraint.id).sort(),
    [...new Set(documentedIds)].sort(),
    'a constraint documented in docs/project-constraints.md is missing from the registry, or vice versa'
  );
});

test('the registry exposes consistent projections', () => {
  assert.equal(getConstraint('C-01').id, 'C-01');
  assert.equal(getConstraint('C-99'), null);
  assert.equal(listConstraints({ tier: 'core' }).every((constraint) => constraint.tier === 'core'), true);
  assert.equal(listConstraints().length, CONSTRAINT_REGISTRY.length);

  const catalog = constraintCatalog();
  assert.equal(catalog.total, CONSTRAINT_REGISTRY.length);
  assert.equal(Object.values(catalog.byTier).reduce((sum, value) => sum + value, 0), catalog.total);
  assert.equal(catalog.tested + catalog.untested.length, catalog.total);
  assert.deepEqual(catalog.drifted, [...DRIFTED_CONSTRAINTS]);
  assert.ok(catalog.byProvenance['ai-subjective'] >= 1, 'the AI-subjective constraints must stay visible');

  const rendered = renderConstraintCatalog();
  for (const constraint of CONSTRAINT_REGISTRY) {
    assert.ok(rendered.includes(`| ${constraint.id} |`), `rendered catalogue is missing ${constraint.id}`);
  }
});
