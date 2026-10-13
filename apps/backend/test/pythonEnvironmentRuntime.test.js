import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { preparePythonEnvironment, validatePythonEnvironment, probePythonEnvironmentCapability, pythonEnvironmentSandboxProfile } from '../src/services/experimentRunner/pythonEnvironmentRuntime.js';

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'python-environment-'));
  const directory = path.join(root, 'environment');
  await fs.mkdir(directory);
  try { await fn({ root, directory }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

// Directory-only ZIP fixtures declare sizes without allocating or unpacking
// those bytes. This exercises the central-directory budget before pip runs.
function zipDirectory(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.size || 0, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(entry.size || 0, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.mode || 0, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, name); central.push(record, name); offset += local.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.reduce((total, part) => total + part.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

test('Python preparation refuses non-absolute paths and invalid budgets before effects', async () => {
  await rejects(preparePythonEnvironment({ directory: 'relative' }), 'PYTHON_ENVIRONMENT_PATH_INVALID');
  await rejects(preparePythonEnvironment({ directory: '/unused', timeoutMs: 0 }), 'PYTHON_ENVIRONMENT_BUDGET_INVALID');
  await rejects(preparePythonEnvironment({ directory: '/unused', maxOutputBytes: 8 * 1024 * 1024 }), 'PYTHON_ENVIRONMENT_BUDGET_INVALID');
});

test('Python preparation never replaces an existing directory or symlink', async () => fixture(async ({ root, directory }) => {
  await fs.writeFile(path.join(directory, 'retained.txt'), 'unchanged');
  await rejects(preparePythonEnvironment({ directory }), 'PYTHON_ENVIRONMENT_NOT_EMPTY');
  assert.equal(await fs.readFile(path.join(directory, 'retained.txt'), 'utf8'), 'unchanged');
  const link = path.join(root, 'link'); await fs.symlink(directory, link);
  await rejects(preparePythonEnvironment({ directory: link }), 'PYTHON_ENVIRONMENT_PATH_INVALID');
}));

test('fixed dependency digest is checked before launching Python', async () => fixture(async ({ root, directory }) => {
  const wheelPath = path.join(root, 'fixed-1.0-py3-none-any.whl');
  await fs.writeFile(wheelPath, 'immutable wheel fixture');
  let launches = 0;
  await rejects(preparePythonEnvironment({ directory, wheels: [{ path: wheelPath, sha256: '0'.repeat(64) }], beforeLaunch: () => { launches++; } }), 'PYTHON_ENVIRONMENT_WHEEL_CHANGED');
  assert.equal(launches, 0);
  assert.deepEqual(await fs.readdir(directory), []);
}));

test('wheel inputs reject duplicate paths, symlinks, malformed hashes, and unbounded count', async () => fixture(async ({ root, directory }) => {
  const wheelPath = path.join(root, 'fixed-1.0-py3-none-any.whl'); await fs.writeFile(wheelPath, 'wheel');
  const sha256 = createHash('sha256').update('wheel').digest('hex');
  const wheel = { path: wheelPath, sha256 };
  await rejects(preparePythonEnvironment({ directory, wheels: [wheel, wheel] }), 'PYTHON_ENVIRONMENT_WHEEL_INVALID');
  await rejects(preparePythonEnvironment({ directory, wheels: [{ ...wheel, sha256: 'not-a-hash' }] }), 'PYTHON_ENVIRONMENT_WHEEL_INVALID');
  await rejects(preparePythonEnvironment({ directory, wheels: Array(31).fill(wheel) }), 'PYTHON_ENVIRONMENT_WHEEL_INVALID');
  const link = path.join(root, 'linked-1.0-py3-none-any.whl'); await fs.symlink(wheelPath, link);
  await rejects(preparePythonEnvironment({ directory, wheels: [{ path: link, sha256 }] }), 'PYTHON_ENVIRONMENT_WHEEL_INVALID');
}));

test('fixed wheel cannot be inside the environment being installed', async () => fixture(async ({ directory }) => {
  // An input in the target makes it nonempty, so it is refused before any runtime.
  const wheelPath = path.join(directory, 'fixed-1.0-py3-none-any.whl'); await fs.writeFile(wheelPath, 'wheel');
  await rejects(preparePythonEnvironment({ directory, wheels: [{ path: wheelPath, sha256: createHash('sha256').update('wheel').digest('hex') }] }), 'PYTHON_ENVIRONMENT_NOT_EMPTY');
}));

test('OS profile denies network and confines writes to only the controlled environment', () => {
  const profile = pythonEnvironmentSandboxProfile({ directory: '/controlled/env', runtimePaths: ['/trusted/runtime'], wheelPaths: ['/fixed/input.whl'] });
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\* \(require-not \(subpath "\/controlled\/env"\)\)\)/);
  assert.ok(!profile.includes('(subpath "/fixed")'));
  assert.ok(!profile.includes('(subpath "/controlled")'));
  assert.ok(!profile.includes(process.env.HOME));
  const readonly = pythonEnvironmentSandboxProfile({ directory: '/controlled/env', runtimePaths: ['/trusted/runtime'], writable: false });
  assert.match(readonly, /\(deny file-write\*\)/);
});

test('capability refuses missing and relative trusted Python configuration without preparation', async () => {
  const previous = process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
  try {
    delete process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
    assert.deepEqual(await probePythonEnvironmentCapability(), { available: false, code: 'PYTHON_RUNTIME_UNAVAILABLE', reason: 'Configure an absolute trusted SCIENCEPRISM_EXPERIMENT_PYTHON interpreter.' });
    process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = 'python3';
    assert.equal((await probePythonEnvironmentCapability()).available, false);
    process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = '/missing/python3';
    assert.equal((await probePythonEnvironmentCapability()).available, false);
  } finally {
    if (previous === undefined) delete process.env.SCIENCEPRISM_EXPERIMENT_PYTHON; else process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = previous;
  }
});

test('runtime preparation fails closed when host configuration or OS sandbox is unavailable', async () => fixture(async ({ directory }) => {
  const capability = await probePythonEnvironmentCapability();
  if (!capability.available) {
    await rejects(preparePythonEnvironment({ directory }), capability.code);
    assert.deepEqual(await fs.readdir(directory), []);
    return;
  }
  const processes = [];
  const result = await preparePythonEnvironment({ directory, onProcess: item => { processes.push(item); } });
  assert.equal(result.python.prefix, await fs.realpath(directory));
  assert.equal(result.python.version, capability.python.version);
  assert.equal(result.isolation, 'macos-sandbox-exec');
  assert.deepEqual(result.packages, []);
  assert.equal(result.installedMetadataSha256, (await validatePythonEnvironment({ directory })).installedMetadataSha256);
  assert.ok(processes.length >= 4);
  for (const item of processes.filter(item => item.stopConfirmed)) assert.throws(() => process.kill(item.pid, 0), { code: 'ESRCH' });
}));

test('durable launch intent precedes every process and its rejection prevents spawn', async () => fixture(async ({ directory }) => {
  const capability = await probePythonEnvironmentCapability();
  if (!capability.available) {
    await rejects(preparePythonEnvironment({ directory }), capability.code);
    return;
  }
  const denied = Object.assign(new Error('intent persistence failed'), { code: 'INTENT_REFUSED' });
  const receipts = []; let authorization = 0; let intent = 0;
  await rejects(preparePythonEnvironment({ directory, beforeLaunch: () => { authorization++; }, onLaunch: () => {
    assert.ok(authorization >= 2); intent++; throw denied;
  }, onProcess: receipt => { receipts.push(receipt); } }), 'INTENT_REFUSED');
  assert.equal(intent, 1); assert.deepEqual(receipts, []);
  assert.equal((await fs.readdir(directory)).includes('bin'), false);
}));

test('wheel ZIP budgets and unsafe entries are rejected before venv creation or installation', async () => fixture(async ({ root, directory }) => {
  const capability = await probePythonEnvironmentCapability();
  if (!capability.available) {
    await rejects(preparePythonEnvironment({ directory }), capability.code);
    return;
  }
  const cases = [
    [{ name: 'oversized.bin', size: 32 * 1024 * 1024 + 1 }],
    Array.from({ length: 5 }, (_, i) => ({ name: `total-${i}.bin`, size: 32 * 1024 * 1024 })),
    Array.from({ length: 30001 }, (_, i) => ({ name: `entry-${i}.bin` })),
    [{ name: '../outside' }], [{ name: '/absolute' }], [{ name: 'folder\\outside' }],
    [{ name: 'duplicate' }, { name: 'duplicate' }],
    [{ name: 'linked', mode: (0o120777 << 16) >>> 0 }],
    [{ name: 'device', mode: (0o020600 << 16) >>> 0 }]
  ];
  for (const [index, entries] of cases.entries()) {
    const target = path.join(root, `invalid-${index}-1.0-py3-none-any.whl`);
    const bytes = zipDirectory(entries); await fs.writeFile(target, bytes);
    const environment = path.join(root, `invalid-environment-${index}`); await fs.mkdir(environment);
    const events = [];
    await rejects(preparePythonEnvironment({ directory: environment, wheels: [{ path: target, sha256: createHash('sha256').update(bytes).digest('hex') }],
      onLaunch: () => events.push('intent'), onProcess: receipt => events.push(receipt) }), 'PYTHON_ENVIRONMENT_WHEEL_ARCHIVE_INVALID');
    assert.equal(events[0], 'intent');
    assert.equal(events.filter(event => typeof event === 'object' && !event.stopConfirmed).length, 1);
    assert.equal((await fs.readdir(environment)).includes('bin'), false);
    for (const receipt of events.filter(event => typeof event === 'object' && event.stopConfirmed)) assert.throws(() => process.kill(receipt.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await fs.readFile(target), bytes);
  }
}));
