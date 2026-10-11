import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { registerFrontendStatic } from '../src/utils/frontendStatic.js';

async function frontend(t) {
  const root = await mkdtemp(join(tmpdir(), 'frontend-update-'));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>initial build</html>');
  await registerFrontendStatic(app, root);
  await app.ready();
  return { app, root };
}

test('a running server serves newly built hashed modules without restarting', async t => {
  const { app, root } = await frontend(t);
  const module = 'export default "writing";';
  await writeFile(join(root, 'assets/EditorPage-new.js'), module);
  const response = await app.inject('/assets/EditorPage-new.js');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /javascript/);
  assert.equal(response.body, module);
});

test('missing hashed resources and API paths return 404 instead of the SPA HTML', async t => {
  const { app } = await frontend(t);
  for (const url of ['/assets/EditorPage-old.js', '/assets/EditorPage-old.js?v=1', '/assets/style-old.css', '/api/unknown']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
    assert.doesNotMatch(response.headers['content-type'], /html/, url);
  }
});

test('the shell and deep writing routes revalidate HTML and see the next build', async t => {
  const { app, root } = await frontend(t);
  for (const version of ['initial build', 'updated build']) {
    await writeFile(join(root, 'index.html'), `<html>${version}</html>`);
    for (const url of ['/', '/index.html', '/editor/project-id?view=writing', '/project/project-id/chat']) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers['cache-control'], 'no-cache', url);
      assert.equal(response.body, `<html>${version}</html>`, url);
    }
  }
});

const source = await readFile(new URL('../../frontend/src/app/pageLoadError.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 } }).outputText;
const { isPageResourceError, pageErrorMessage } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('module and CSS loading failures select the page resource recovery message', () => {
  for (const error of [
    new TypeError('Failed to fetch dynamically imported module: /assets/EditorPage-old.js'),
    new TypeError('Importing a module script failed.'),
    new Error('Loading chunk 123 failed.'),
    new Error('Unable to preload CSS for /assets/editor.css'),
    { name: 'ChunkLoadError', message: 'missing chunk' },
  ]) assert.equal(isPageResourceError(error), true, pageErrorMessage(error));
});

test('ordinary network and application failures are not claimed to be stale page resources', () => {
  for (const error of [null, undefined, 42, {}, { message: null }, new Error('Failed to fetch'), new Error('Invalid project')]) {
    assert.equal(isPageResourceError(error), false);
  }
  assert.equal(pageErrorMessage('details'), 'details');
  assert.equal(pageErrorMessage(null), '');
});
