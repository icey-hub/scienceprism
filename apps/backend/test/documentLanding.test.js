import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const {
  DOCUMENT_LANDING_DIR_NAME,
  assertDocumentLandingPath,
  resolveDocumentLandingDir
} = await import('../src/services/researchWorkflow/documentLanding.js');

test('the document landing directory defaults to aidoc/ under the repository root', () => {
  assert.equal(DOCUMENT_LANDING_DIR_NAME, 'aidoc');
  assert.equal(resolveDocumentLandingDir('/repo'), path.join('/repo', 'aidoc'));
});

test('an explicit landing directory overrides the default', () => {
  assert.equal(resolveDocumentLandingDir('/repo', { override: '/elsewhere/out' }), path.resolve('/elsewhere/out'));
});

test('a produced document must land under aidoc/', () => {
  const landing = resolveDocumentLandingDir('/repo');

  assert.equal(
    assertDocumentLandingPath(path.join(landing, 'proj', 'research', 'writing-brief.md'), landing),
    'proj/research/writing-brief.md'
  );

  // R-15 exists to keep tool output out of the agent-governance docs.
  assert.throws(
    () => assertDocumentLandingPath('/repo/docs/agent-governance/iterations.md', landing),
    /must land under aidoc/
  );
  assert.throws(() => assertDocumentLandingPath('/repo/elsewhere/file.md', landing), /must land under aidoc/);
  assert.throws(() => assertDocumentLandingPath(landing, landing), /must land under aidoc/);
});

// Both drivers are scanned. The first version only scanned
// produce-research-document.mjs, so a refactor that stripped the landing logic
// out of render-brief-pdf.mjs would have passed with half the drivers broken.
// Each driver asserts the invariant it can express: the landing directory is
// resolved in code, assigned before importing services, and checked on output.
// The variable names differ between them, so only the shared invariant is common.
const DRIVERS = ['produce-research-document.mjs', 'render-brief-pdf.mjs'];

test('the driver pins the landing directory instead of inheriting it', async () => {
  for (const driver of DRIVERS) {
    const source = await readFile(new URL(`../../../scripts/${driver}`, import.meta.url), 'utf8');

    assert.match(
      source,
      /resolveDocumentLandingDir\(REPO_ROOT/,
      `${driver} must resolve the landing directory from the repo root`
    );
    assert.match(
      source,
      /process\.env\.SCIENCEPRISM_DATA_DIR = LANDING_DIR/,
      `${driver} must assign the pinned landing directory`
    );
    assert.match(
      source,
      /assertDocumentLandingPath\(\w+, LANDING_DIR\)/,
      `${driver} must assert that its output lands under the landing directory`
    );
    // The gitignored .env must not be able to move the landing directory, which is
    // how R-15 held before: only by accident of a local environment file.
    assert.ok(
      !/process\.env\.SCIENCEPRISM_DATA_DIR\s*\|\|/.test(source),
      `${driver} must not fall back to the environment for the landing directory`
    );
  }
});
