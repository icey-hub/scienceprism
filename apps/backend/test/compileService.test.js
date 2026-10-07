import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const cache = path.resolve('.cache');
await fs.mkdir(cache, { recursive: true });
const data = await fs.mkdtemp(path.join(cache, 'compile-test-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { runCompile } = await import('../src/services/compileService.js');
const { registerCompileRoutes } = await import('../src/routes/compile.js');
const { default: Fastify } = await import('fastify');
const bin = path.join(data, 'bin');
await fs.mkdir(bin);
const originalPath = process.env.PATH;
process.env.PATH = bin;
test.after(async () => {
  process.env.PATH = originalPath;
  // data is the verified, uniquely-created fixture directory under this repo.
  assert.equal(path.dirname(data), cache);
  await fs.rm(data, { recursive: true, force: true });
});
const fixture = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const bib = path.basename(process.argv[1]) === 'bibtex';
if (bib) {
  console.log('BIB:' + fs.readFileSync(path.join(process.env.BIBINPUTS.slice(0,-1), 'refs.bib'), 'utf8'));
} else {
  console.log('ARGS:' + JSON.stringify(args));
  const out = args.find(x => x.startsWith('-output-directory=') || x.startsWith('-outdir='))?.split('=').slice(1).join('=') || args[args.indexOf('--outdir') + 1];
  const main = args.at(-1);
  const text = fs.readFileSync(main, 'utf8');
  console.log('INPUT:' + text + ':' + fs.readFileSync('section.tex', 'utf8'));
  const original = process.env.COMPILE_FIXTURE_ORIGINAL;
  fs.writeFileSync(path.join(original, 'main.tex'), 'changed main');
  fs.writeFileSync(path.join(original, 'section.tex'), 'changed section');
  fs.writeFileSync(path.join(original, 'refs.bib'), 'changed bib');
  fs.writeFileSync(path.join(out, path.basename(main, '.tex') + '.aux'), 'aux');
  if (text !== 'NO_PDF') fs.writeFileSync(path.join(out, path.basename(main, '.tex') + '.pdf'), '%PDF-fixture:' + text);
  if (text === 'FAIL_WITH_PDF') process.exitCode = 1;
}
`;
for (const executable of ['pdflatex', 'bibtex']) {
  await fs.writeFile(path.join(bin, executable), fixture, { mode: 0o755 });
}
async function project(main = 'original main') {
  const id = crypto.randomUUID();
  const root = path.join(data, id);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: 'compile fixture' }));
  await fs.writeFile(path.join(root, 'main.tex'), main);
  await fs.writeFile(path.join(root, 'section.tex'), 'original section');
  await fs.writeFile(path.join(root, 'refs.bib'), 'original bib');
  await fs.writeFile(path.join(root, 'figure.png'), Buffer.from([0, 255, 123]));
  await fs.writeFile(path.join(root, '.env'), 'SECRET=not-an-input');
  await fs.mkdir(path.join(root, '.scienceprism'));
  await fs.writeFile(path.join(root, '.scienceprism', 'state.json'), '{}');
  process.env.COMPILE_FIXTURE_ORIGINAL = root;
  return { id, root };
}
async function waitFor(check) {
  for (let i = 0; i < 300; i += 1) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Fixture readiness timeout');
}
async function slowCompiler(root, executable = 'pdflatex') {
  await fs.writeFile(path.join(bin, executable), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(path.join(root, 'ready'))}, String(process.pid));
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(path.join(root, 'survived'))}, 'still running');
  process.exit(0);
}, 1800);
`, { mode: 0o755 });
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function assertClean(root) {
  assert.deepEqual(await fs.readdir(path.join(root, '.compile')), []);
}

test('all compiler and bibliography passes use copied bytes despite live edits', async () => {
  const { id, root } = await project();
  const result = await runCompile({ projectId: id, mainFile: 'main.tex' });
  assert.equal(result.ok, true, result.error);
  assert.equal(Buffer.from(result.pdf, 'base64').toString(), '%PDF-fixture:original main');
  assert.equal(result.log.match(/INPUT:original main:original section/g)?.length, 3);
  assert.match(result.log, /BIB:original bib/);
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'changed main');
  const snapshot = result.inputSnapshot;
  assert.equal(snapshot.mainFile, 'main.tex');
  assert.equal(snapshot.engine, 'pdflatex');
  assert.match(snapshot.runId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(snapshot.files.map(file => file.path), ['figure.png', 'main.tex', 'refs.bib', 'section.tex']);
  assert.equal(snapshot.files.find(file => file.path === 'main.tex').sha256, hash('original main'));
  assert.equal(snapshot.files[0].sha256, hash(Buffer.from([0, 255, 123])));
  assert.equal(snapshot.files[0].bytes, 3);
  assert.equal(snapshot.hash, hash(JSON.stringify({ mainFile: snapshot.mainFile, engine: snapshot.engine, files: snapshot.files })));
  await assertClean(root);
});

test('nonzero exit with a PDF is a failure and retains snapshot diagnostics', async () => {
  const { id, root } = await project('FAIL_WITH_PDF');
  const result = await runCompile({ projectId: id, mainFile: 'main.tex' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.pdf, undefined);
  assert.ok(result.inputSnapshot);
  await assertClean(root);
});

test('missing PDF and missing engine retain manifest and clean temporary inputs', async () => {
  for (const [main, engine] of [['NO_PDF', 'pdflatex'], ['original main', 'xelatex']]) {
    const { id, root } = await project(main);
    const result = await runCompile({ projectId: id, mainFile: 'main.tex', engine });
    assert.equal(result.ok, false);
    assert.ok(result.inputSnapshot);
    await assertClean(root);
  }
});

test('TeX engines request explicit file-line diagnostics without passing the flag to Tectonic', async () => {
  for (const engine of ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic']) {
    await fs.writeFile(path.join(bin, engine), fixture, { mode: 0o755 });
    const { id, root } = await project();
    const result = await runCompile({ projectId: id, mainFile: 'main.tex', engine });
    assert.equal(result.ok, true, result.error);
    const passes = result.log.split('\n').filter(line => line.startsWith('ARGS:')).map(line => JSON.parse(line.slice(5)));
    assert.ok(passes.length);
    for (const args of passes) assert.equal(args.includes('-file-line-error'), engine !== 'tectonic', engine);
    await assertClean(root);
  }
});

test('Tectonic ignored bibliography errors fail even across chunks after log truncation', async () => {
  for (const prefix of ['', 'x'.repeat(210_000)]) {
    const { id, root } = await project();
    await fs.writeFile(path.join(bin, 'tectonic'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'main.pdf'), '%PDF-invalid-bibliography');
process.stdout.write(${JSON.stringify(prefix)});
process.stderr.write('warning: errors were issued by Bib');
setTimeout(() => {
  process.stdout.write('interleaved chatter');
  setTimeout(() => process.stderr.write('TeX, but were ignored; use --print for details.\\n'), 30);
}, 30);
`, { mode: 0o755 });
    const result = await runCompile({ projectId: id, mainFile: 'main.tex', engine: 'tectonic' });
    assert.equal(result.ok, false);
    assert.match(result.error, /bibliography/i);
    assert.equal(result.status, 0, 'preserve the actual engine exit code');
    assert.equal(result.pdf, undefined);
    assert.ok(result.inputSnapshot);
    assert.ok(result.log.length <= 200_000);
    await assertClean(root);
  }
});

test('ordinary Tectonic warnings retain PDF and request detailed diagnostics', async () => {
  const { id, root } = await project();
  await fs.writeFile(path.join(bin, 'tectonic'), fixture.replace("console.log('ARGS:' + JSON.stringify(args));", "console.log('ARGS:' + JSON.stringify(args)); console.error('warning: Underfull box');"), { mode: 0o755 });
  const result = await runCompile({ projectId: id, mainFile: 'main.tex', engine: 'tectonic' });
  assert.equal(result.ok, true);
  assert.ok(result.pdf);
  assert.match(result.log, /--print/);
  await assertClean(root);
});

test('unsafe inputs fail closed without compiling or leaving a snapshot directory', async () => {
  const { id, root } = await project();
  await fs.symlink(path.join(root, 'section.tex'), path.join(root, 'linked.tex'));
  await assert.rejects(runCompile({ projectId: id, mainFile: 'main.tex' }), /symbolic|symlink|Invalid path/i);
  await assertClean(root);
  for (const mainFile of ['../other.tex', '-shell-escape', '.env', 'missing.tex']) {
    await assert.rejects(runCompile({ projectId: id, mainFile }));
  }
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'original main');
});

test('pre-aborted compilation never launches a compiler', async () => {
  const { id, root } = await project();
  const controller = new AbortController();
  controller.abort();
  const result = await runCompile({ projectId: id, mainFile: 'main.tex', signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.code, 'COMPILE_CANCELLED');
  assert.equal(result.pdf, undefined);
  assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'original main');
});

test('abort waits for stubborn compiler termination and cleanup, including bibliography', async () => {
  for (const executable of ['pdflatex', 'bibtex']) {
    const { id, root } = await project();
    await slowCompiler(root, executable);
    const controller = new AbortController();
    try {
      const pending = runCompile({ projectId: id, mainFile: 'main.tex', signal: controller.signal });
      const pid = Number(await waitFor(() => fs.readFile(path.join(root, 'ready'), 'utf8').catch(() => '')));
      controller.abort();
      const result = await pending;
      assert.equal(result.cancelled, true);
      assert.equal(result.pdf, undefined);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(await fs.stat(path.join(root, 'survived')).then(() => true, () => false), false);
      await assertClean(root);
    } finally { await fs.writeFile(path.join(bin, executable), fixture, { mode: 0o755 }); }
  }
});

test('POSIX cancellation kills remaining children after the compiler leader exits', { skip: process.platform === 'win32' }, async () => {
  const { id, root } = await project();
  const childCode = `const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(path.join(root, 'child-ready'))}, String(process.pid));
setTimeout(() => { fs.writeFileSync(${JSON.stringify(path.join(root, 'child-survived'))}, 'alive'); }, 1200);
setTimeout(() => process.exit(0), 2000);`;
  await fs.writeFile(path.join(bin, 'pdflatex'), `#!${process.execPath}
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'inherit' });
setTimeout(() => process.exit(0), 2200);
`, { mode: 0o755 });
  const controller = new AbortController();
  try {
    const pending = runCompile({ projectId: id, mainFile: 'main.tex', signal: controller.signal });
    const childPid = Number(await waitFor(() => fs.readFile(path.join(root, 'child-ready'), 'utf8').catch(() => '')));
    controller.abort();
    assert.equal((await pending).cancelled, true);
    await waitFor(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
    assert.equal(await fs.stat(path.join(root, 'child-survived')).then(() => true, () => false), false);
    await assertClean(root);
  } finally { await fs.writeFile(path.join(bin, 'pdflatex'), fixture, { mode: 0o755 }); }
});

test('task cancellation waits for compile finalization and cannot be overwritten by success', async () => {
  const { id, root } = await project();
  const { cancelTask, getTask, listTasks, createTask } = await import('../src/services/projectHub/taskCenter.js');
  const app = Fastify();
  registerCompileRoutes(app);
  await slowCompiler(root);
  try {
    const pending = app.inject({ method: 'POST', url: '/api/compile', payload: { projectId: id } });
    // Start the lazy injection before waiting for its child process.
    const responsePromise = pending.then(response => response);
    await waitFor(() => fs.readFile(path.join(root, 'ready'), 'utf8').catch(() => ''));
    const [task] = await listTasks(id, { kind: 'compile' });
    const other = await project();
    await assert.rejects(cancelTask(other.id, task.id), /not found/i);
    const [first, second] = await Promise.all([cancelTask(id, task.id), cancelTask(id, task.id)]);
    assert.equal(first.task.status, 'cancelled');
    assert.equal(second.task.status, 'cancelled');
    await assertClean(root);
    const result = (await responsePromise).json();
    assert.equal(result.cancelled, true);
    assert.equal(result.pdf, undefined);
    assert.equal((await getTask(id, task.id)).status, 'cancelled');
    const orphan = await createTask(id, { kind: 'compile', status: 'running' });
    await assert.rejects(cancelTask(id, orphan.id), /not active in this server/i);
    assert.equal((await getTask(id, orphan.id)).status, 'running');
  } finally {
    await app.close();
    await fs.writeFile(path.join(bin, 'pdflatex'), fixture, { mode: 0o755 });
  }
});

test('real HTTP task cancellation stops compile and subsequent compile can succeed', async () => {
  const { id, root } = await project();
  const { registerProjectHubRoutes } = await import('../src/routes/projectHub.js');
  const app = Fastify();
  registerCompileRoutes(app);
  registerProjectHubRoutes(app);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  await slowCompiler(root);
  try {
    const pending = fetch(`${address}/api/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: id }) }).then(r => r.json());
    await waitFor(() => fs.readFile(path.join(root, 'ready'), 'utf8').catch(() => ''));
    const tasks = await fetch(`${address}/api/projects/${id}/tasks`).then(r => r.json());
    const task = tasks.tasks.find(item => item.kind === 'compile');
    const response = await fetch(`${address}/api/projects/${id}/tasks/${task.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.task.status, 'cancelled');
    assert.equal((await pending).code, 'COMPILE_CANCELLED');
    await assertClean(root);
    await fs.writeFile(path.join(bin, 'pdflatex'), fixture, { mode: 0o755 });
    const next = await fetch(`${address}/api/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: id }) }).then(r => r.json());
    assert.equal(next.ok, true, next.error);
    assert.notEqual(next.taskId, task.id);
  } finally {
    await app.close();
    await fs.writeFile(path.join(bin, 'pdflatex'), fixture, { mode: 0o755 });
  }
});

test('compile registry seals completion and isolates ownership', async () => {
  const { registerCompileCancellation, cancelActiveCompile } = await import('../src/services/compileCancellation.js');
  const owner = registerCompileCancellation('project-one', 'task-one');
  assert.throws(() => registerCompileCancellation('project-one', 'task-one'), /already registered/);
  await assert.rejects(cancelActiveCompile('project-two', 'task-one'), /not active/);
  owner.seal();
  let settled = false;
  const cancel = cancelActiveCompile('project-one', 'task-one').then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(owner.signal.aborted, false);
  owner.finish();
  await cancel;
  await assert.rejects(cancelActiveCompile('project-one', 'task-one'), /not active/);
  const failed = registerCompileCancellation('project-one', 'task-two');
  const rejected = assert.rejects(cancelActiveCompile('project-one', 'task-two'), /disk error/);
  failed.finish(new Error('disk error'));
  await rejected;
});

test('compile route preserves the exact returned manifest in task metadata', async () => {
  const { id, root } = await project();
  const app = Fastify();
  registerCompileRoutes(app);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/compile', payload: { projectId: id, engine: 'pdflatex' } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.ok, true, result.error);
    const { getTask } = await import('../src/services/projectHub/taskCenter.js');
    const task = await getTask(id, result.taskId);
    assert.deepEqual(task.metadata.inputSnapshot, result.inputSnapshot);
    assert.ok(task.metadata.inputSnapshot);
    await assertClean(root);
  } finally { await app.close(); }
});
