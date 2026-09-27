import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cacheRoot = path.join(repoRoot, '.cache');
await mkdir(cacheRoot, { recursive: true });
const dataDir = await mkdtemp(path.join(cacheRoot, 'research-skill-test-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { readEnabledResearchSkillDocument } = await import('../src/services/researchResearch/researchSkills.js');

test('Legacy can read only an enabled built-in Skill and its Markdown references', async () => {
  await mkdir(path.join(dataDir, 'test'));
  await writeFile(path.join(dataDir, 'test', 'project.json'), JSON.stringify({ id: 'test' }));
  const enabledSkillNames = ['paper-figure-style'];
  const main = await readEnabledResearchSkillDocument({ projectId: 'test', enabledSkillNames, name: 'paper-figure-style' });
  assert.match(main, /# Paper Figure Style/);
  const reference = await readEnabledResearchSkillDocument({ projectId: 'test', enabledSkillNames, name: 'paper-figure-style', file: 'references/01-figure-style-guide.md' });
  assert.ok(reference.length > 100);
  await assert.rejects(
    readEnabledResearchSkillDocument({ projectId: 'test', enabledSkillNames: [], name: 'paper-figure-style' }),
    /not enabled/
  );
  await assert.rejects(
    readEnabledResearchSkillDocument({ projectId: 'test', enabledSkillNames, name: 'paper-figure-style', file: '../research-writing/SKILL.md' }),
    /inside its Skill folder/
  );
});

test('project Skill overrides the built-in and symlink escape is rejected', async () => {
  const projectId = 'test-project';
  const projectRoot = path.join(dataDir, projectId);
  const skillRoot = path.join(projectRoot, '.dsh', 'skills', 'paper-figure-style');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({ id: projectId }));
  await writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: paper-figure-style\ndescription: Local project figure instructions with enough detail to be discovered by the catalog.\nmetadata:\n  stages: [writing]\n---\n\n# Project override\n');
  const args = { projectId, enabledSkillNames: ['paper-figure-style'], name: 'paper-figure-style' };
  assert.match(await readEnabledResearchSkillDocument(args), /# Project override/);
  await assert.rejects(
    readEnabledResearchSkillDocument({ ...args, capabilityPolicy: { granted: ['project.read'], allowedPaths: ['main.tex'] } }),
    /Harness path denied/
  );
  await symlink(path.join(projectRoot, 'project.json'), path.join(skillRoot, 'escaped.md'));
  await assert.rejects(readEnabledResearchSkillDocument({ ...args, file: 'escaped.md' }), /escapes its Skill folder/);
});

test.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
