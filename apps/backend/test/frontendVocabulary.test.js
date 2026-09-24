import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const frontendSrc = path.join(repoRoot, 'apps', 'frontend', 'src');

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name)) await walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(frontendSrc);
const sources = new Map();
for (const file of files) sources.set(file, await readFile(file, 'utf8'));

test('the research stage vocabulary has exactly one definition', () => {
  const relative = (file) => path.relative(repoRoot, file);

  for (const name of ['ResearchStageId', 'HarnessResearchStageId']) {
    const declarers = [...sources]
      .filter(([, text]) => new RegExp(`export type ${name}\\b`).test(text))
      .map(([file]) => relative(file));

    // Two independent literal lists both named ResearchStageId is exactly the
    // bug this replaced: they differed, and passing one where the other was
    // expected failed with no hint that two vocabularies existed.
    assert.deepEqual(declarers, [path.join('apps', 'frontend', 'src', 'researchStageIds.ts')], `${name} must be declared once`);
  }
});

test('the two stage vocabularies differ only at the innovation stage', async () => {
  const { RESEARCH_STAGES } = await import(path.join(frontendSrc, 'app', 'research', 'researchStages.ts'));
  const { toHarnessResearchStage, fromHarnessResearchStage } = await import(path.join(frontendSrc, 'app', 'research', 'researchStages.ts'));

  assert.equal(RESEARCH_STAGES.length, 8);
  for (const stage of RESEARCH_STAGES) {
    if (stage.id === 'innovation') {
      assert.equal(stage.harnessId, 'ideation');
      continue;
    }
    assert.equal(stage.harnessId, stage.id, `${stage.id} should be spelled the same in both vocabularies`);
  }

  // The bridge round-trips, so a caller cannot lose a stage by translating.
  for (const stage of RESEARCH_STAGES) {
    assert.equal(fromHarnessResearchStage(toHarnessResearchStage(stage.id)), stage.id);
  }
});

test('the api layer does not depend on the app layer', () => {
  const offenders = [];
  for (const [file, text] of sources) {
    if (!file.includes(`${path.sep}api${path.sep}`)) continue;
    for (const match of text.matchAll(/from '([^']+)'/g)) {
      if (match[1].includes('/app/') || match[1].startsWith('../app')) offenders.push(`${path.relative(repoRoot, file)} → ${match[1]}`);
    }
  }

  // The shared vocabulary module exists so this stays true; the api layer
  // importing app code would invert the dependency the split was made to avoid.
  assert.deepEqual(offenders, []);
});
