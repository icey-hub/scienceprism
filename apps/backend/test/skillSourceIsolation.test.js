import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await fs.mkdtemp(path.join(repo, '.cache/skill-source-isolation-'));
process.env.SCIENCEPRISM_DATA_DIR = root;
const { listSkillCatalog, readEnabledSkillDocument } = await import('../src/services/skillCatalog.js');
const { copyWorkspace, snapshotWorkspace, collectPatches } = await import('../src/services/harnessRuntime/workspace.js');
const { buildContextPack } = await import('../src/services/harnessRuntime/contextPackager.js');
const policy = { granted: ['project.read', 'patch.propose'], allowedPaths: [], networkAllowlist: [] };
const project = path.join(root, 'scope');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, 'project.json'), '{"id":"scope"}');
await fs.writeFile(path.join(project, 'main.tex'), 'original manuscript');
for (const [base, name] of [['.agents', 'chosen'], ['.agents', 'unselected'], ['.dsh', 'legacy']]) {
  const folder = path.join(project, base, 'skills', name);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: text only\n---\n${'x'.repeat(45000)}`);
  await fs.writeFile(path.join(folder, '.scienceprism-source.json'), '{"must":"not enter the model"}');
}

test('a metadata-only recommendation cannot silently read manuscript, workflow or evidence context', async t => {
  const calls = []; const original = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', (...args) => { calls.push(String(args[0])); return original(...args); });
  const pack = await buildContextPack({ projectId: 'scope', projectRoot: project,
    request: { task: 'skill_recommendation', prompt: 'compare provided candidates', activePath: 'main.tex', contextFiles: ['main.tex'] },
    policy: { granted: [], allowedPaths: [], networkAllowlist: [] } });
  assert.deepEqual(pack.files, []);
  assert.deepEqual(pack.evidence, []);
  assert.equal(calls.length, 0);
  assert.equal(pack.instructions.prompt, 'compare provided candidates');
});

test('selected catalog reads no unselected Skill body; internal full reads retain the exact bytes', async t => {
  const calls = []; const original = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', (...args) => { calls.push(String(args[0])); return original(...args); });
  assert.deepEqual((await listSkillCatalog({ projectId: 'scope', names: ['chosen'] })).skills.map(item => item.name), ['chosen']);
  const args = { projectId: 'scope', name: 'chosen', enabledSkillNames: ['chosen'], capabilityPolicy: policy };
  const bounded = await readEnabledSkillDocument(args);
  const full = await readEnabledSkillDocument({ ...args, fullDocument: true });
  assert.match(bounded, /truncated after 40,000/);
  assert.equal(full, await original(path.join(project, '.agents/skills/chosen/SKILL.md'), 'utf8'));
  assert.ok(calls.every(file => !file.includes('/skills/') || file.includes('/skills/chosen/')));
});

test('source Skills never enter project context, workspace copy, or new/deleted manuscript patches', async () => {
  const workspace = path.join(root, 'workspace');
  await copyWorkspace(project, workspace, policy);
  for (const base of ['.agents', '.dsh']) await assert.rejects(fs.stat(path.join(workspace, base, 'skills')), { code: 'ENOENT' });
  const pack = await buildContextPack({ projectId: 'scope', projectRoot: project, request: { activePath: '.agents/skills/chosen/SKILL.md', contextFiles: ['.agents/skills/chosen/.scienceprism-source.json', '.dsh/skills/legacy/SKILL.md'] }, policy, constraints: {} });
  assert.ok(pack.files.every(file => !/\.(agents|dsh)\/skills/.test(file.path)));
  const snapshot = await snapshotWorkspace(workspace, policy);
  snapshot.set('.agents/skills/chosen/SKILL.md', 'stale snapshot');
  await fs.mkdir(path.join(workspace, '.dsh/skills/projected'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.dsh/skills/projected/SKILL.md'), 'projection');
  await fs.writeFile(path.join(workspace, 'main.tex'), 'new manuscript');
  assert.deepEqual((await collectPatches(snapshot, workspace, policy)).map(patch => patch.path), ['main.tex']);
});
