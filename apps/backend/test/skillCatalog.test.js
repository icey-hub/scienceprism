import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(repoRoot, '.cache'), { recursive: true });
const dataDir = await mkdtemp(path.join(repoRoot, '.cache/skill-catalog-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { listSkillCatalog, readEnabledSkillDocument } = await import('../src/services/skillCatalog.js');
const { listResearchSkills } = await import('../src/services/researchResearch/researchSkills.js');
async function project(id) {
  const root = path.join(dataDir, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id }));
  return root;
}
async function skill(root, name, stages = '', body = 'Actual skill body') {
  const folder = path.join(root, '.dsh/skills', name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: A useful text skill for manuscript checks.\n${stages}---\n${body}`);
  return folder;
}

test('generic text skills are discoverable and readable but never automatically research-bound', async () => {
  const root = await project('generic');
  await skill(root, 'plain-text');
  await skill(root, 'stage-text', 'metadata:\n  stages: [writing]\n');
  const { skills } = await listSkillCatalog({ projectId: 'generic' });
  assert.equal(skills.find(s => s.name === 'plain-text').available, true);
  assert.deepEqual(skills.find(s => s.name === 'plain-text').stages, []);
  assert.ok(!JSON.stringify(skills).includes('Actual skill body'));
  const research = await listResearchSkills({ projectId: 'generic' });
  assert.ok(!research.some(s => s.name === 'plain-text'));
  assert.ok(research.some(s => s.name === 'stage-text'));
  assert.match(await readEnabledSkillDocument({ projectId: 'generic', name: 'plain-text', enabledSkillNames: ['plain-text'] }), /Actual skill body/);
  await assert.rejects(readEnabledSkillDocument({ projectId: 'generic', name: 'plain-text' }), /not enabled/);
});

test('missing, malformed and invalid-stage definitions report reasons instead of disappearing', async () => {
  const root = await project('invalid');
  await mkdir(path.join(root, '.dsh/skills/missing'), { recursive: true });
  await skill(root, 'unknown-stage', 'stages: [not-a-stage]\n');
  await skill(root, 'bad-list', 'stages: writing\n');
  const bad = await skill(root, 'bad-name');
  await writeFile(path.join(bad, 'SKILL.md'), '---\nname: another-name\ndescription: description\n---\n');
  const { skills } = await listSkillCatalog({ projectId: 'invalid' });
  for (const name of ['unknown-stage', 'bad-list', 'bad-name']) {
    assert.equal(skills.find(s => s.name === name).reason, 'INVALID_METADATA');
  }
  assert.equal(skills.find(s => s.name === 'missing').reason, 'MISSING_DOCUMENT');
});

test('invalid local override blocks fallback; valid override preserves source and shadows metadata', async () => {
  const root = await project('override');
  const folder = path.join(root, '.dsh/skills/research-writing');
  await mkdir(folder, { recursive: true });
  let catalog = await listSkillCatalog({ projectId: 'override' });
  assert.equal(catalog.skills.find(s => s.name === 'research-writing').shadows, 'built-in');
  assert.equal(catalog.skills.find(s => s.name === 'research-writing').available, false);
  assert.ok(!(await listResearchSkills({ projectId: 'override' })).some(s => s.name === 'research-writing'));
  await assert.rejects(readEnabledSkillDocument({ projectId: 'override', name: 'research-writing', enabledSkillNames: ['research-writing'] }), /MISSING_DOCUMENT/);
  await skill(root, 'research-writing', 'stages: [writing]\n', 'Local body');
  catalog = await listSkillCatalog({ projectId: 'override' });
  assert.equal(catalog.skills.find(s => s.name === 'research-writing').source, 'project');
  assert.match(await readEnabledSkillDocument({ projectId: 'override', name: 'research-writing', enabledSkillNames: ['research-writing'] }), /Local body/);
});

test('literal description preserves newlines and stage aliases normalize with surrounding whitespace', async () => {
  const root = await project('literal');
  const folder = await skill(root, 'literal-text');
  await writeFile(path.join(folder, 'SKILL.md'), '---\nname: literal-text\ndescription: |-\n  First line.\n  Second line.\nmetadata:\n  stages: [ideation]\n---\nBody\n');
  const { skills } = await listSkillCatalog({ projectId: 'literal' });
  assert.equal(skills.find(s => s.name === 'literal-text').description, 'First line.\nSecond line.');
  assert.ok((await listResearchSkills({ projectId: 'literal', stage: ' innovation ' })).some(s => s.name === 'literal-text'));
});

test('catalog and document enforce project paths, capability allowlists, Markdown and size limits', async () => {
  const root = await project('restricted');
  const other = await project('other');
  const outside = await skill(other, 'escaped');
  const inside = await skill(root, 'inside');
  await symlink(outside, path.join(root, '.dsh/skills/escaped'));
  await symlink(path.join(other, 'project.json'), path.join(inside, 'reference.md'));
  await writeFile(path.join(inside, 'large.md'), 'x'.repeat(128001));
  const { skills } = await listSkillCatalog({ projectId: 'restricted' });
  assert.equal(skills.find(s => s.name === 'escaped').reason, 'PATH_ESCAPE');
  const denied = await listSkillCatalog({ projectId: 'restricted', capabilityPolicy: { granted: ['project.read'], allowedPaths: ['main.tex'] } });
  assert.equal(denied.skills.find(s => s.name === 'inside').reason, 'PERMISSION_DENIED');
  const args = { projectId: 'restricted', name: 'inside', enabledSkillNames: ['inside'] };
  await assert.rejects(readEnabledSkillDocument({ ...args, file: '../escaped/SKILL.md' }), /inside its Skill folder/);
  await assert.rejects(readEnabledSkillDocument({ ...args, file: 'script.js' }), /inside its Skill folder/);
  await assert.rejects(readEnabledSkillDocument({ ...args, file: 'reference.md' }), /escapes its Skill folder/);
  await assert.rejects(readEnabledSkillDocument({ ...args, file: 'large.md' }), /TOO_LARGE/);
  await assert.rejects(readEnabledSkillDocument({ ...args, capabilityPolicy: { granted: ['project.read'], allowedPaths: ['main.tex'] } }), /Harness path denied/);
});
