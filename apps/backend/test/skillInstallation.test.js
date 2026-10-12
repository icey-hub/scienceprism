import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { createGithubSkillSource } from '../src/services/skillDiscovery/github.js';
import { createSkillInstallationService, normalizeSelectedSkill } from '../src/services/skillInstallation/index.js';
import { createSkillInstallationRepository, SOURCE_LOCK, LICENSE_DIRECTORY, sha256 } from '../src/services/skillInstallation/repository.js';
import { registerSkillInstallationRoutes } from '../src/routes/skillInstallation.js';

const commit = 'a'.repeat(40); const treeSha = 'b'.repeat(40);
const skillContent = '---\nname: paper-notes\ndescription: Write paper reading notes.\n---\nUse references/guide.md. Do not execute anything during installation.\n';
const baseFiles = () => ({ 'LICENSE': Buffer.from('SPDX-License-Identifier: MIT\nSynthetic root license fixture'),
  'skills/LICENSE.txt': Buffer.from('Synthetic ancestor license fixture'),
  'skills/paper-notes/SKILL.md': Buffer.from(skillContent),
  'skills/paper-notes/references/guide.md': Buffer.from('Reference text and original relative link [plot](../assets/plot.svg).\n'),
  'skills/paper-notes/assets/plot.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'),
  'skills/paper-notes/scripts/example.js': Buffer.from('throw new Error("INSTALLER MUST NOT EXECUTE ME");'),
  'skills/paper-notes/package.json': Buffer.from('{"scripts":{"postinstall":"touch INSTALLER_MUST_NOT_RUN"},"dependencies":{"example":"1.0"}}') });
const selection = overrides => ({ confirmed: true, selected: { repository: 'example/catalog', commit, path: 'skills/paper-notes', digest: sha256(Buffer.from(skillContent)), ...overrides } });
async function setup(options = {}) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/skills/', import.meta.url)); await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'installation-')); await fs.writeFile(path.join(root, 'project.json'), '{}');
  const files = { ...baseFiles(), ...options.files }; const calls = [];
  const transport = async url => {
    calls.push(url); if (options.fail) throw options.fail;
    if (url === 'https://api.github.com/repos/example/catalog') return Buffer.from(JSON.stringify({ private: false }));
    if (url.includes('/commits/')) return Buffer.from(JSON.stringify({ sha: options.commit || commit, commit: { tree: { sha: treeSha } } }));
    if (url.includes('/git/trees/')) {
      const tree = { sha: treeSha, truncated: false, tree: Object.entries(files).map(([name, data]) => ({ path: name, type: 'blob', mode: '100644', size: data.length,
        sha: createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') })) };
      return Buffer.from(JSON.stringify(options.tree ? options.tree(tree) : tree));
    }
    const revision = options.commit || commit;
    assert.ok(url.startsWith(`https://raw.githubusercontent.com/example/catalog/${revision}/`));
    const name = decodeURIComponent(url.split(`/${revision}/`)[1]); assert.ok(Object.hasOwn(files, name)); return files[name];
  };
  const resolveProject = async id => { assert.equal(id, 'project'); return root; };
  const repository = createSkillInstallationRepository({ resolveProject, fsOps: options.fsOps || fs });
  const service = createSkillInstallationService({ resolveProject, repository, listInstalled: async () => ({ skills: options.installed || [] }),
    sourceFactory: createGithubSkillSource({ transport, maxRequests: 70 }) });
  return { root, files, calls, repository, service, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('installation requires one explicitly confirmed pinned source, not query/ref/implicit automation approval', () => {
  assert.equal(normalizeSelectedSkill(selection()).commit, commit);
  for (const input of [{ selected: selection().selected }, { confirmed: false, selected: selection().selected }, { ...selection(), automate: true },
    selection({ commit: 'main' }), selection({ digest: '' }), selection({ path: '../outside' }), selection({ token: 'secret' })]) assert.throws(() => normalizeSelectedSkill(input));
});

test('standard SKILL without stages installs atomically with unchanged references/scripts/SVG and ancestor licenses', async () => {
  const f = await setup();
  try {
    const result = await f.service.install('project', selection());
    assert.equal(result.installation.state, 'installed'); assert.equal(result.installation.integrity, 'verified'); assert.equal(result.duplicate, false);
    assert.equal(result.scriptsExecuted, false); assert.equal(result.bindingsChanged, false); assert.equal(result.runtimeVerified, false);
    const target = path.join(f.root, '.agents/skills/paper-notes');
    for (const [name, bytes] of Object.entries(f.files)) {
      const local = name.startsWith('skills/paper-notes/') ? name.slice('skills/paper-notes/'.length) : `${LICENSE_DIRECTORY}/${name}`;
      assert.deepEqual(await fs.readFile(path.join(target, local)), bytes);
    }
    const lock = JSON.parse(await fs.readFile(path.join(target, SOURCE_LOCK), 'utf8'));
    assert.equal(lock.source.commit, commit); assert.equal(lock.source.digest, selection().selected.digest); assert.equal(lock.files.length, 7);
    assert.equal(lock.files.find(file => file.path === `${LICENSE_DIRECTORY}/LICENSE`).originalPath, 'LICENSE');
    assert.equal((await f.repository.list('project')).installations[0].integrity, 'verified');
    assert.deepEqual(await fs.readdir(path.join(f.root, '.scienceprism/skill-installations-staging')), []);
    assert.equal((await fs.readdir(f.root, { recursive: true })).some(name => name.includes('INSTALLER_MUST_NOT_RUN')), false);
    const duplicate = await f.service.install('project', selection()); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.installation.installedAt, lock.installedAt);
  } finally { await f.close(); }
});

test('source digest changes, legacy/built-in name conflicts and unconfirmed requests leave no installation', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.service.install('project', { selected: selection().selected }), { code: 'SKILL_INSTALLATION_SELECTION_REQUIRED' }); assert.equal(f.calls.length, 0);
    await assert.rejects(f.service.install('project', selection({ digest: 'c'.repeat(64) })), { code: 'SKILL_INSTALLATION_SELECTION_CHANGED' });
    assert.deepEqual(await fs.readdir(f.root), ['project.json']);
  } finally { await f.close(); }
  const conflict = await setup({ installed: [{ name: 'paper-notes', source: 'built-in', relativePath: '.dsh/skills/paper-notes/SKILL.md' }] });
  try { await assert.rejects(conflict.service.install('project', selection()), { code: 'SKILL_INSTALLATION_NAME_CONFLICT' }); assert.deepEqual(await fs.readdir(conflict.root), ['project.json']); }
  finally { await conflict.close(); }
});

test('binary assets, malformed manifests, reserved paths, case conflicts and linked packages fail closed without omissions', async () => {
  const cases = [
    { files: { 'skills/paper-notes/assets/image.png': Buffer.from([137, 80, 78, 71, 0, 255]) }, code: 'SKILL_INSTALLATION_BINARY_UNSUPPORTED' },
    { files: { 'skills/paper-notes/package.json': Buffer.from('{broken') }, code: 'SKILL_INSTALLATION_INVALID_MANIFEST' },
    { files: { [`skills/paper-notes/${SOURCE_LOCK}`]: Buffer.from('{}') }, code: 'SKILL_INSTALLATION_RESERVED_PATH' },
    { files: { 'skills/paper-notes/skill.md': Buffer.from('case collision') }, code: 'SKILL_INSTALLATION_UNSAFE_PACKAGE' },
    { tree: tree => ({ ...tree, tree: tree.tree.map(file => file.path.endsWith('example.js') ? { ...file, mode: '120000' } : file) }), code: 'SKILL_INSTALLATION_UNSAFE_PACKAGE' },
    { tree: tree => ({ ...tree, tree: tree.tree.map(file => file.path === 'LICENSE' ? { ...file, mode: '120000' } : file) }), code: 'SKILL_INSTALLATION_UNSAFE_PACKAGE' }
  ];
  for (const spec of cases) {
    const f = await setup(spec);
    try { await assert.rejects(f.service.install('project', selection()), { code: spec.code }); assert.deepEqual(await fs.readdir(f.root), ['project.json']); }
    finally { await f.close(); }
  }
});

test('file count and byte limits reject before package download; malicious paths never escape', async () => {
  for (const tree of [
    value => ({ ...value, tree: [...value.tree, ...Array.from({ length: 65 }, (_, i) => ({ ...value.tree[0], path: `skills/paper-notes/extra-${i}.txt` }))] }),
    value => ({ ...value, tree: value.tree.map(file => file.path.endsWith('example.js') ? { ...file, size: 512_001 } : file) }),
    value => ({ ...value, tree: [...value.tree, { ...value.tree[0], path: 'skills/paper-notes/../../outside.txt' }] })
  ]) {
    const f = await setup({ tree });
    try { await assert.rejects(f.service.install('project', selection())); assert.deepEqual(await fs.readdir(f.root), ['project.json']); assert.ok(f.calls.length <= 4); }
    finally { await f.close(); }
  }
});

test('local edits, extra files, corrupt locks and unmanaged folders are visible and never overwritten', async () => {
  const f = await setup();
  try {
    await f.service.install('project', selection()); const target = path.join(f.root, '.agents/skills/paper-notes');
    await fs.writeFile(path.join(target, 'references/guide.md'), 'user modification');
    await fs.writeFile(path.join(target, 'extra.txt'), 'user added');
    let row = (await f.service.list('project')).installations[0]; assert.equal(row.state, 'modified'); assert.ok(row.issues.includes('modified:references/guide.md')); assert.ok(row.issues.includes('extra:extra.txt'));
    await assert.rejects(f.service.install('project', selection()), { code: 'SKILL_INSTALLATION_NAME_CONFLICT' });
    assert.equal(await fs.readFile(path.join(target, 'references/guide.md'), 'utf8'), 'user modification');
    await fs.writeFile(path.join(target, SOURCE_LOCK), '{broken'); row = (await f.service.list('project')).installations[0]; assert.equal(row.state, 'invalid-lock');
    await assert.rejects(f.service.install('project', selection()), { code: 'SKILL_INSTALLATION_NAME_CONFLICT' });
    await fs.rm(path.join(target, SOURCE_LOCK)); row = (await f.service.list('project')).installations[0]; assert.equal(row.state, 'unmanaged');
    await assert.rejects(f.service.install('project', selection()), { code: 'SKILL_INSTALLATION_NAME_CONFLICT' });
  } finally { await f.close(); }
});

test('project symlink escapes and symlinks added to an installed package are rejected', async () => {
  const f = await setup(); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  try {
    await fs.symlink(outside, path.join(f.root, '.agents'));
    await assert.rejects(f.service.install('project', selection()), { code: 'SKILL_INSTALLATION_UNSAFE_PATH' }); assert.deepEqual(await fs.readdir(outside), []);
    await fs.rm(path.join(f.root, '.agents')); await f.service.install('project', selection());
    const target = path.join(f.root, '.agents/skills/paper-notes'); await fs.symlink(outside, path.join(target, 'linked'));
    assert.equal((await f.service.list('project')).installations[0].state, 'modified');
    await assert.rejects(f.service.install('project', selection()), { code: 'SKILL_INSTALLATION_NAME_CONFLICT' });
  } finally { await f.close(); }
});

test('interrupted staging and failed publication clean staging and allow a clean retry', async () => {
  for (const mode of ['write', 'rename', 'cancel']) {
    const abort = new AbortController(); let failed = false; let publicationFailed = false;
    const fsOps = { ...fs,
      async writeFile(file, ...args) { if (!failed && file.endsWith('SKILL.md')) { failed = true; if (mode === 'write') throw new Error('synthetic disk failure'); if (mode === 'cancel') abort.abort(); } return fs.writeFile(file, ...args); },
      async rename(...args) { if (mode === 'rename' && !publicationFailed) { publicationFailed = true; throw new Error('synthetic publication failure'); } return fs.rename(...args); }
    };
    const f = await setup({ fsOps });
    try {
      await assert.rejects(f.service.install('project', selection(), { signal: abort.signal }));
      assert.deepEqual(await fs.readdir(path.join(f.root, '.agents/skills')), []);
      assert.deepEqual(await fs.readdir(path.join(f.root, '.scienceprism/skill-installations-staging')), []);
      assert.equal((await f.service.install('project', selection())).installation.integrity, 'verified');
    } finally { await f.close(); }
  }
});

test('concurrent identical selections publish one complete directory and then return an idempotent result', async () => {
  const f = await setup();
  try {
    const results = await Promise.all([f.service.install('project', selection()), f.service.install('project', selection())]);
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
    assert.equal((await f.service.list('project')).installations.length, 1);
  } finally { await f.close(); }
});

test('HTTP installation requires explicit confirmation; list separates installed integrity from execution/binding', async () => {
  const f = await setup(); const app = Fastify(); registerSkillInstallationRoutes(app, { service: f.service });
  try {
    const url = '/api/projects/project/skill-installations';
    assert.equal((await app.inject({ method: 'POST', url, payload: { selected: selection().selected } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url, payload: selection() }); assert.equal(response.statusCode, 201); assert.equal(response.json().scriptsExecuted, false);
    assert.equal((await app.inject({ method: 'POST', url, payload: selection() })).statusCode, 200);
    const list = await app.inject(url); assert.equal(list.statusCode, 200); assert.equal(list.json().installations[0].integrity, 'verified');
  } finally { await app.close(); await f.close(); }
});

const changeRevision = (f, options, revision = 'c'.repeat(40), content = `${skillContent}\nA new fixed revision.\n`) => {
  options.commit = revision; f.files['skills/paper-notes/SKILL.md'] = Buffer.from(content);
  return { repository: 'example/catalog', commit: revision, path: 'skills/paper-notes', digest: sha256(Buffer.from(content)) };
};
test('update preview is read-only; explicit update preserves the old version and rollback/uninstall keep documents addressable', async () => {
  const options = {}; const f = await setup(options);
  try {
    const first = (await f.service.install('project', selection())).installation;
    const selected = changeRevision(f, options);
    f.files['skills/paper-notes/references/new.md'] = Buffer.from('New reference'); delete f.files['skills/paper-notes/references/guide.md'];
    const preview = await f.service.previewUpdate('project', 'paper-notes', { selected, expectedVersionId: first.versionId });
    assert.equal(preview.installationPerformed, false); assert.equal(preview.requiresConfirmation, true);
    assert.deepEqual(new Set(preview.changes.map(change => change.change)), new Set(['added', 'removed', 'changed']));
    assert.match(preview.changes.find(change => change.path === 'SKILL.md').diff, /A new fixed revision/);
    assert.equal((await f.service.list('project')).installations[0].versionId, first.versionId);
    await assert.rejects(f.service.update('project', 'paper-notes', { selected, expectedVersionId: first.versionId }), { code: 'SKILL_INSTALLATION_SELECTION_REQUIRED' });
    const updated = (await f.service.update('project', 'paper-notes', { selected, expectedVersionId: first.versionId, confirmed: true })).installation;
    assert.notEqual(updated.versionId, first.versionId);
    assert.equal((await f.service.document('project', 'paper-notes', first.versionId, 'SKILL.md')).content, skillContent);
    assert.equal((await f.service.versions('project', 'paper-notes')).versions.length, 2);
    const rollback = await f.service.rollback('project', 'paper-notes', { versionId: first.versionId, expectedVersionId: updated.versionId, confirmed: true });
    assert.equal(rollback.installation.versionId, first.versionId); assert.equal(rollback.bindingsChanged, false);
    const removed = await f.service.uninstall('project', 'paper-notes', { expectedVersionId: first.versionId, confirmed: true });
    assert.equal(removed.uninstalled, true); assert.deepEqual((await f.service.list('project')).installations, []);
    assert.equal((await f.service.document('project', 'paper-notes', updated.versionId, 'references/new.md')).content, 'New reference');
    assert.equal((await f.service.document('project', 'paper-notes', first.versionId, 'SKILL.md')).content, skillContent);
  } finally { await f.close(); }
});

test('a new commit with identical files is a distinct source version; stale approvals and local edits block lifecycle writes', async () => {
  const options = {}; const f = await setup(options);
  try {
    const first = (await f.service.install('project', selection())).installation;
    const selected = changeRevision(f, options, 'c'.repeat(40), skillContent);
    const preview = await f.service.previewUpdate('project', 'paper-notes', { selected, expectedVersionId: first.versionId });
    assert.deepEqual(preview.changes, []); assert.notEqual(preview.selected.versionId, first.versionId);
    const updated = (await f.service.update('project', 'paper-notes', { selected, expectedVersionId: first.versionId, confirmed: true })).installation;
    await assert.rejects(f.service.uninstall('project', 'paper-notes', { expectedVersionId: first.versionId, confirmed: true }), { code: 'SKILL_INSTALLATION_VERSION_CONFLICT' });
    await fs.writeFile(path.join(f.root, '.agents/skills/paper-notes/references/guide.md'), 'Personal notes');
    assert.equal((await f.service.document('project', 'paper-notes', updated.versionId, 'references/guide.md')).content, 'Reference text and original relative link [plot](../assets/plot.svg).\n');
    await assert.rejects(f.service.previewUpdate('project', 'paper-notes', { selected, expectedVersionId: updated.versionId }), { code: 'SKILL_INSTALLATION_LOCAL_CHANGES' });
    await assert.rejects(f.service.rollback('project', 'paper-notes', { versionId: first.versionId, expectedVersionId: updated.versionId, confirmed: true }), { code: 'SKILL_INSTALLATION_LOCAL_CHANGES' });
    await assert.rejects(f.service.uninstall('project', 'paper-notes', { expectedVersionId: updated.versionId, confirmed: true }), { code: 'SKILL_INSTALLATION_LOCAL_CHANGES' });
    assert.equal(await fs.readFile(path.join(f.root, '.agents/skills/paper-notes/references/guide.md'), 'utf8'), 'Personal notes');
  } finally { await f.close(); }
});

test('each directory-switch interruption restores or completes one version, including recovery by a fresh repository instance', async () => {
  for (const point of ['before-first', 'after-first', 'after-second']) {
    let armed = false; let tripped = false;
    const options = { fsOps: { ...fs, async rename(from, to) {
      const first = to.endsWith('/previous'); const second = from.endsWith('/payload');
      if (armed && !tripped && ((point === 'before-first' || point === 'after-first') ? first : second)) {
        tripped = true;
        if (point !== 'before-first') await fs.rename(from, to);
        throw new Error(`Interrupted at ${point}`);
      }
      // A sustained failure prevents same-call recovery, simulating an exited
      // writer. The next repository instance uses normal fs operations.
      if (armed && tripped && from.endsWith('/previous')) throw new Error('Writer no longer available');
      return fs.rename(from, to);
    } } };
    const f = await setup(options);
    try {
      const first = (await f.service.install('project', selection())).installation;
      const selected = changeRevision(f, options); armed = true;
      await assert.rejects(f.service.update('project', 'paper-notes', { selected, expectedVersionId: first.versionId, confirmed: true }));
      const restarted = createSkillInstallationRepository({ resolveProject: async () => f.root });
      const result = await restarted.list('project'); assert.equal(result.installations[0].integrity, 'verified');
      assert.equal(result.installations[0].source.commit, point === 'after-second' ? selected.commit : commit);
      assert.deepEqual(await fs.readdir(path.join(f.root, '.scienceprism/skill-installation-transactions')), []);
      assert.deepEqual(await fs.readdir(path.join(f.root, '.scienceprism/skill-installations-staging')), []);
      assert.equal((await restarted.document('project', 'paper-notes', first.versionId, 'SKILL.md')).content, skillContent);
    } finally { await f.close(); }
  }
});

test('history reads verify hashes and restrict paths; tampered history is never used for rollback', async () => {
  const options = {}; const f = await setup(options);
  try {
    const first = (await f.service.install('project', selection())).installation; const selected = changeRevision(f, options);
    const updated = (await f.service.update('project', 'paper-notes', { selected, expectedVersionId: first.versionId, confirmed: true })).installation;
    await assert.rejects(f.service.document('project', 'paper-notes', first.versionId, '../project.json'), { code: 'SKILL_INSTALLATION_INVALID_DOCUMENT' });
    await assert.rejects(f.service.document('project', 'paper-notes', first.versionId, 'scripts/example.js'), { code: 'SKILL_INSTALLATION_INVALID_DOCUMENT' });
    await fs.writeFile(path.join(f.root, '.scienceprism/skill-installation-history/paper-notes', first.versionId, 'SKILL.md'), 'Tampered history');
    await assert.rejects(f.service.document('project', 'paper-notes', first.versionId), { code: 'SKILL_INSTALLATION_LOCAL_CHANGES' });
    await assert.rejects(f.service.rollback('project', 'paper-notes', { expectedVersionId: updated.versionId, versionId: first.versionId, confirmed: true }), { code: 'SKILL_INSTALLATION_LOCAL_CHANGES' });
    assert.equal((await f.service.list('project')).installations[0].versionId, updated.versionId);
  } finally { await f.close(); }
});

test('lifecycle HTTP routes expose bounded diffs and require fresh single-action confirmation', async () => {
  const options = {}; const f = await setup(options); const app = Fastify(); registerSkillInstallationRoutes(app, { service: f.service });
  try {
    const base = '/api/projects/project/skill-installations';
    const first = (await app.inject({ method: 'POST', url: base, payload: selection() })).json().installation;
    const selected = changeRevision(f, options);
    const preview = await app.inject({ method: 'POST', url: `${base}/paper-notes/update-preview`, payload: { selected, expectedVersionId: first.versionId } });
    assert.equal(preview.statusCode, 200); assert.ok(preview.json().changes.length);
    const refused = await app.inject({ method: 'POST', url: `${base}/paper-notes/update`, payload: { selected, expectedVersionId: first.versionId } }); assert.equal(refused.statusCode, 400);
    const updated = (await app.inject({ method: 'POST', url: `${base}/paper-notes/update`, payload: { selected, expectedVersionId: first.versionId, confirmed: true } })).json().installation;
    const history = await app.inject(`${base}/paper-notes/versions`); assert.equal(history.statusCode, 200); assert.equal(history.json().versions.length, 2);
    const old = await app.inject(`${base}/paper-notes/versions/${first.versionId}/document?file=SKILL.md`); assert.equal(old.statusCode, 200); assert.equal(old.json().content, skillContent);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/paper-notes/uninstall`, payload: { expectedVersionId: first.versionId, confirmed: true } })).statusCode, 409);
    const rollback = await app.inject({ method: 'POST', url: `${base}/paper-notes/rollback`, payload: { versionId: first.versionId, expectedVersionId: updated.versionId, confirmed: true } }); assert.equal(rollback.statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/paper-notes/uninstall`, payload: { expectedVersionId: first.versionId, confirmed: true } })).statusCode, 200);
    assert.equal((await app.inject(`${base}/paper-notes/versions/${updated.versionId}/document?file=SKILL.md`)).statusCode, 200);
  } finally { await app.close(); await f.close(); }
});
