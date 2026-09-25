import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', 'src');
const repoRoot = path.join(here, '..', '..', '..');
const applicationSource = path.join(srcRoot, 'services', 'researchWorkflow', 'application.js');

const {
  DEFAULT_RESEARCH_SKILL_BINDINGS,
  HARNESS_EXECUTED_STAGES,
  RESEARCH_SKILL_STAGE_ALIASES,
  listResearchSkills
} = await import('../src/services/researchResearch/researchSkills.js');

test('HARNESS_EXECUTED_STAGES still matches the stages application.js invokes', async () => {
  const source = await readFile(applicationSource, 'utf8');
  const invoked = [...source.matchAll(/runResearchStage\(\{\s*stage:\s*'([a-z_]+)'/g)].map((match) => match[1]);
  // The application names contract stages; skills bind to workflow stages.
  const normalized = [...new Set(invoked.map((stage) => RESEARCH_SKILL_STAGE_ALIASES[stage] || stage))].sort();

  assert.ok(invoked.length >= 4, `expected the research stage calls in application.js, found ${invoked.length}`);
  assert.deepEqual(normalized, [...HARNESS_EXECUTED_STAGES].sort());
});

test('no skill binding points at a stage that never runs a Harness Run', () => {
  for (const stage of Object.keys(DEFAULT_RESEARCH_SKILL_BINDINGS)) {
    assert.ok(
      HARNESS_EXECUTED_STAGES.includes(stage),
      `a binding for "${stage}" can never load: that stage runs no Harness Run`
    );
  }
});

test('every bundled skill is reachable from a stage that runs a Harness Run', async () => {
  const catalog = await listResearchSkills({});
  assert.ok(catalog.length >= 5, `expected the bundled skill catalog, found ${catalog.length}`);

  for (const skill of catalog) {
    assert.ok(
      skill.stages.some((stage) => HARNESS_EXECUTED_STAGES.includes(stage)),
      `skill "${skill.name}" is bound to no stage that runs a Harness Run: ${skill.stages.join(', ')}`
    );
  }
});

test('the bundled skill set is locked', async () => {
  const catalog = await listResearchSkills({});
  // Locked on purpose: adding or removing a bundled skill changes what every
  // research stage is told, so it should be a deliberate edit of this list.
  assert.deepEqual(
    catalog.map((skill) => skill.name).sort(),
    [
      'claim-evidence-audit',
      'dataset-audit',
      'experiment-design-audit',
      'figure-table-plan',
      'literature-search',
      'paper-card',
      'paper-figure-style',
      'research-writing',
      'statistics-audit'
    ]
  );
});

test('.dsh/skills holds only product skills, so nothing is silently dropped', async () => {
  const skillsRoot = path.join(repoRoot, '.dsh', 'skills');
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  // The loader silently drops a directory whose SKILL.md lacks a valid name,
  // description, or stage list (researchSkills.js). That silence is the risk: a
  // dev-side playbook dropped in here would simply vanish from every research
  // run. Dev-side assets belong in docs/agent-governance/playbooks/.
  const catalog = await listResearchSkills({});
  assert.deepEqual(
    directories,
    catalog.map((skill) => skill.name).sort(),
    'a directory under .dsh/skills was silently dropped: it needs valid name/description/stages frontmatter'
  );
});

test('every bundled skill reaches the model with a usable description', async () => {
  const { researchSkillPrompt } = await import('../src/services/researchResearch/researchSkills.js');
  const catalog = await listResearchSkills({});

  for (const skill of catalog) {
    // A description written as a YAML block scalar (`description: >-`) used to be
    // parsed as the literal string ">-", so the skill reached every run with no
    // usable description and nothing failed. Assert on the parsed value, because
    // that is what researchSkillPrompt hands the model.
    assert.ok(
      typeof skill.description === 'string' && skill.description.length >= 40,
      `skill "${skill.name}" has no usable description (got ${JSON.stringify(skill.description)})`
    );
    assert.ok(
      !/^[>|][-+]?\d*$/.test(skill.description.trim()),
      `skill "${skill.name}" description is a YAML block-scalar header, not text: the parser failed to read its body`
    );
  }

  // The prompt is the thing that actually degrades, so check it end to end.
  const prompt = researchSkillPrompt('writing', catalog);
  assert.ok(!/:\s*>-/.test(prompt), 'a block-scalar header leaked into the stage prompt');
  for (const skill of catalog.filter((entry) => entry.stages.includes('writing'))) {
    assert.ok(prompt.includes(skill.description), `prompt is missing the description for ${skill.name}`);
  }
});
