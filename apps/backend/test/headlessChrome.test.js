import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runHeadlessChrome } from '../../../scripts/lib/headless-chrome.mjs';

const cacheRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.cache');
await mkdir(cacheRoot, { recursive: true });
const work = await mkdtemp(path.join(cacheRoot, 'chrome-runner-test-'));
const executable = path.join(work, 'fake-chrome');
await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log(JSON.stringify(args));
if (args.includes('--fail')) { console.error('render rejected'); process.exit(7); }
if (args.includes('--hang')) setInterval(() => {}, 1000);
`);
await chmod(executable, 0o755);
test.after(() => rm(work, { recursive: true, force: true }));

function profileFrom(stdout) {
  return JSON.parse(stdout).find((arg) => arg.startsWith('--user-data-dir=')).split('=')[1];
}

test('Chrome renders use separate repo-local profiles and clean them up', async () => {
  const first = await runHeadlessChrome(['--dump-dom', 'file:///figure.html'], { executable });
  const second = await runHeadlessChrome(['--dump-dom', 'file:///figure.html'], { executable });
  const firstProfile = profileFrom(first);
  const secondProfile = profileFrom(second);
  assert.notEqual(firstProfile, secondProfile);
  assert.equal(path.dirname(firstProfile), cacheRoot);
  await assert.rejects(access(firstProfile), { code: 'ENOENT' });
  await assert.rejects(access(secondProfile), { code: 'ENOENT' });
  assert.ok(JSON.parse(first).includes('file:///figure.html'));
});

test('Chrome failures and timeouts reject with diagnostics and clean their profiles', async () => {
  for (const args of [['--fail'], ['--hang']]) {
    let profile;
    await assert.rejects(runHeadlessChrome(args, { executable, timeout: 1000 }), (error) => {
      assert.match(error.message, args[0] === '--fail' ? /render rejected/ : /SIGKILL/);
      assert.ok(error.cause.stdout);
      profile = profileFrom(error.cause.stdout);
      return true;
    });
    await assert.rejects(access(profile), { code: 'ENOENT' });
  }
});

test('a missing Chrome executable fails explicitly', async () => {
  await assert.rejects(runHeadlessChrome([], { executable: path.join(work, 'missing') }), /ENOENT/);
});
