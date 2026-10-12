import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cache = path.join(repo, '.cache/research-workbench-v2/skills'); await fs.mkdir(cache, { recursive: true });
const root = await fs.mkdtemp(path.join(cache, 'projection-')); process.env.SCIENCEPRISM_DATA_DIR = root;
const { projectSelectedSkillDocuments, sourceForProjectedSkillRead, clearWorkspaceSkillSources } = await import('../src/services/skillRuntime/projection.js');
const { listResearchSkills, resolveResearchSkillBindings, validateResearchSkillBindings, researchSkillPrompt } = await import('../src/services/researchResearch/researchSkills.js');
const { readEnabledSkillDocument } = await import('../src/services/skillCatalog.js');
const { createSourceLock, skillVersionId, createSkillInstallationRepository } = await import('../src/services/skillInstallation/repository.js');
test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const text = (name, extra = '', body = 'Use references/guide.md for details.') => `---\nname: ${name}\ndescription: ${name} explains research notes clearly.\n${extra}---\n${body}\n`;
async function fixture(id, entries = {}) {
  const projectRoot = path.join(root, id); const workspaceRoot = path.join(root, `${id}-workspace`);
  await fs.mkdir(projectRoot); await fs.mkdir(workspaceRoot); await fs.writeFile(path.join(projectRoot, 'project.json'), '{}');
  for (const [file, content] of Object.entries(entries)) { const target = path.join(projectRoot, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
  return { projectId: id, projectRoot, workspaceRoot, capabilityPolicy: { granted: ['project.read'], allowedPaths: [] } };
}

test('selected projection reads the actual owner only for selected documents and omits scripts, locks, metadata and nested Skills', async () => {
  const selected = '.agents/skills/selected-notes';
  const options = await fixture('selected', {
    [`${selected}/SKILL.md`]: text('selected-notes'), [`${selected}/references/guide.md`]: 'Reference body',
    [`${selected}/scripts/README.md`]: 'Executable helper instructions, do not project', [`${selected}/scripts/fail.js`]: 'throw new Error("do not run")',
    [`${selected}/metadata.json`]: '{"source":"keep private metadata out of runtime"}',
    [`${selected}/.scienceprism-licenses/LICENSE.md`]: 'Preserved license metadata, not a selected instruction',
    [`${selected}/child/SKILL.md`]: text('child'), [`${selected}/child/references/private.md`]: 'Nested unselected Skill',
    '.agents/skills/unselected-notes/SKILL.md': text('unselected-notes'), '.agents/skills/unselected-notes/references/private.md': 'Never read this body'
  });
  const reads = []; const readFile = fs.readFile;
  fs.readFile = async (file, ...args) => { reads.push(String(file)); return readFile(file, ...args); };
  let projection;
  try { projection = await projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['selected-notes'] }); }
  finally { fs.readFile = readFile; }
  assert.equal(projection.format, 'markdown-only'); assert.equal(projection.scriptsIncluded, false); assert.equal(projection.runtimeVerified, false);
  assert.equal(reads.some(file => file.includes('unselected-notes') || file.includes('/scripts/') || file.includes('/child/') || file.endsWith('.scienceprism-source.json')), false);
  assert.deepEqual(projection.documents.map(doc => doc.projectionPath), ['.dsh/skills/selected-notes/SKILL.md', '.dsh/skills/selected-notes/references/guide.md']);
  assert.deepEqual(projection.excludedPaths, ['.agents/skills', '.dsh/skills']);
  for (const document of projection.documents) {
    const original = await fs.readFile(path.join(options.projectRoot, document.sourceRelativePath));
    assert.deepEqual(await fs.readFile(path.join(options.workspaceRoot, document.projectionPath)), original);
    assert.equal(document.sha256, createHash('sha256').update(original).digest('hex'));
  }
  assert.equal((await fs.readdir(options.workspaceRoot, { recursive: true })).some(file => file.endsWith('.json') || file.includes('scripts')), false);
});

test('full selected document preserves source version beyond ordinary tool truncation and maps reads to source', async () => {
  const content = text('long-notes', '', 'Long scientific writing notes. '.repeat(2000));
  const options = await fixture('long', { '.agents/skills/long-notes/SKILL.md': content });
  const projection = await projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['long-notes'] });
  const document = projection.documents[0]; assert.equal(document.bytes, Buffer.byteLength(content));
  assert.equal(document.sha256, createHash('sha256').update(content).digest('hex'));
  const ordinary = await readEnabledSkillDocument({ projectId: options.projectId, enabledSkillNames: ['long-notes'], name: 'long-notes' });
  assert.match(ordinary, /truncated after 40,000/); assert.notEqual(ordinary, content);
  const source = sourceForProjectedSkillRead(projection, document.projectionPath); assert.equal(source.sourceRelativePath, '.agents/skills/long-notes/SKILL.md'); assert.equal(source.sha256, document.sha256);
  assert.equal(sourceForProjectedSkillRead(projection, '.dsh/skills/other/SKILL.md'), null);
  assert.equal(sourceForProjectedSkillRead(projection, '../.dsh/skills/long-notes/SKILL.md'), null);
});

test('project precedence and invalid local overrides fail closed; selected builtin references remain supported', async () => {
  const options = await fixture('override', { '.agents/skills/paper-card/SKILL.md': text('paper-card', '', 'Active project source'), '.dsh/skills/paper-card/SKILL.md': text('paper-card', '', 'Shadowed legacy source') });
  let projection = await projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['paper-card'] });
  assert.equal(projection.documents[0].sourceRelativePath, '.agents/skills/paper-card/SKILL.md');
  assert.match(await fs.readFile(path.join(options.workspaceRoot, projection.documents[0].projectionPath), 'utf8'), /Active project source/);
  await fs.writeFile(path.join(options.projectRoot, '.agents/skills/paper-card/SKILL.md'), 'broken');
  await assert.rejects(projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['paper-card'] }), { code: 'SKILL_PROJECTION_UNAVAILABLE' });
  projection = await projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['paper-figure-style'] });
  assert.ok(projection.documents.some(doc => doc.sourceRelativePath.endsWith('references/01-figure-style-guide.md')));
  assert.ok(projection.documents.every(doc => doc.source === 'built-in'));
});

test('empty selection clears stale stores without reading any Skill; original project and repository are protected', async () => {
  const options = await fixture('empty', { '.agents/skills/keep-me/SKILL.md': text('keep-me') });
  for (const prefix of ['.agents/skills', '.dsh/skills']) { await fs.mkdir(path.join(options.workspaceRoot, prefix, 'stale'), { recursive: true }); await fs.writeFile(path.join(options.workspaceRoot, prefix, 'stale/SKILL.md'), 'stale'); }
  const reads = []; const readFile = fs.readFile; fs.readFile = async (file, ...args) => { reads.push(String(file)); return readFile(file, ...args); };
  let projection; try { projection = await projectSelectedSkillDocuments({ ...options, enabledSkillNames: [] }); } finally { fs.readFile = readFile; }
  assert.deepEqual(projection.documents, []); assert.equal(reads.length, 0);
  await assert.rejects(fs.access(path.join(options.workspaceRoot, '.agents/skills')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(options.workspaceRoot, '.dsh/skills')), { code: 'ENOENT' });
  await assert.rejects(projectSelectedSkillDocuments({ ...options, workspaceRoot: options.projectRoot }), { code: 'SKILL_PROJECTION_NOT_ISOLATED' });
  await assert.rejects(clearWorkspaceSkillSources(repo, { projectRoot: options.projectRoot }), { code: 'SKILL_PROJECTION_NOT_ISOLATED' });
  assert.equal(await fs.readFile(path.join(options.projectRoot, '.agents/skills/keep-me/SKILL.md'), 'utf8'), text('keep-me'));
});

test('capability/path denial, cancellation, unknown selection and linked references cannot leak into projection', async () => {
  const options = await fixture('deny', { '.agents/skills/private-notes/SKILL.md': text('private-notes') });
  await assert.rejects(projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['private-notes'], capabilityPolicy: { granted: ['project.read'], allowedPaths: ['main.tex'] } }), { code: 'SKILL_PROJECTION_UNAVAILABLE' });
  await assert.rejects(projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['not-installed'] }), { code: 'SKILL_PROJECTION_UNAVAILABLE' });
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['private-notes'], signal: cancelled.signal }));
  await fs.symlink(path.join(options.projectRoot, 'project.json'), path.join(options.projectRoot, '.agents/skills/private-notes/escape.md'));
  await assert.rejects(projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['private-notes'] }), { code: 'SKILL_PROJECTION_UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(options.workspaceRoot), []);
});

test('generic Skills are eligible only through explicit stage bindings and do not expand defaults', async () => {
  const options = await fixture('generic', { '.agents/skills/generic-notes/SKILL.md': text('generic-notes') });
  assert.equal((await listResearchSkills({ projectId: options.projectId })).some(skill => skill.name === 'generic-notes'), false);
  const catalog = await listResearchSkills({ projectId: options.projectId, includeGeneric: true });
  assert.ok(catalog.some(skill => skill.name === 'generic-notes' && skill.stages.length === 0));
  const defaults = resolveResearchSkillBindings({}, catalog); assert.ok(Object.values(defaults).every(names => !names.includes('generic-notes')));
  const explicit = validateResearchSkillBindings({ writing: ['generic-notes'], search: [] }, catalog);
  assert.deepEqual(resolveResearchSkillBindings(explicit, catalog).writing, ['generic-notes']); assert.deepEqual(resolveResearchSkillBindings(explicit, catalog).search, []);
  assert.match(researchSkillPrompt('writing', catalog.filter(skill => skill.name === 'generic-notes')), /generic-notes/);
  assert.throws(() => validateResearchSkillBindings({ writing: ['bad'] }, [{ name: 'bad', stages: [], available: false }]), /Unknown/);
  assert.throws(() => validateResearchSkillBindings({ writing: ['limited'] }, [{ name: 'limited', stages: ['search'] }]), /not compatible/);
  assert.equal(resolveResearchSkillBindings({}, [{ name: 'paper-card', stages: [] }]).selection.length, 0);
});

test('managed projection records version identity and holds the project lock across reads before lifecycle writes', async () => {
  const content = text('versioned-notes'); const digest = createHash('sha256').update(content).digest('hex');
  const lock = createSourceLock({ name: 'versioned-notes', source: { repository: 'example/catalog', commit: 'a'.repeat(40), path: 'skills/versioned-notes', digest },
    files: [{ path: 'SKILL.md', originalPath: 'skills/versioned-notes/SKILL.md', size: Buffer.byteLength(content), digest, kind: 'original' }] });
  const options = await fixture('serialized'); const repository = createSkillInstallationRepository();
  await repository.install(options.projectId, { lock, files: [{ path: 'SKILL.md', bytes: Buffer.from(content) }] });
  let entered; const reading = new Promise(resolve => { entered = resolve; });
  let release; const resume = new Promise(resolve => { release = resolve; });
  let paused = false; const readFile = fs.readFile;
  fs.readFile = async (file, ...args) => {
    if (!paused && String(file).endsWith('versioned-notes/SKILL.md')) { paused = true; entered(); await resume; }
    return readFile(file, ...args);
  };
  let projection;
  try {
    const pending = projectSelectedSkillDocuments({ ...options, enabledSkillNames: ['versioned-notes'] }); await reading;
    const uninstalling = repository.uninstall(options.projectId, 'versioned-notes', { expectedVersionId: skillVersionId(lock) });
    const state = await Promise.race([uninstalling.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('waiting'), 15))]);
    assert.equal(state, 'waiting'); release(); projection = await pending; await uninstalling;
  } finally { release(); fs.readFile = readFile; }
  assert.equal(projection.documents[0].versionId, skillVersionId(lock));
  assert.equal(sourceForProjectedSkillRead(projection, '.dsh/skills/versioned-notes/SKILL.md').versionId, skillVersionId(lock));
  assert.equal((await repository.document(options.projectId, 'versioned-notes', skillVersionId(lock))).content, content);
});
