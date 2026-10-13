import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { prepareMcpStdio, confirmMcpStopped, assertRetainedMcpStopped } from '../src/services/mcp/isolation.js';
import { createMcpTransport } from '../src/services/mcp/transport.js';

const cache = path.resolve('.cache/research-workbench-v2/mcp-tool-policy');
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, 'isolation-data-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = path.join(root, 'project');fs.mkdirSync(path.join(source, 'safe'), { recursive: true });
fs.writeFileSync(path.join(source, 'safe/note.txt'), 'allowed input');
fs.writeFileSync(path.join(source, 'outside.txt'), 'private outside');
fs.writeFileSync(path.join(source, '.env'), 'private fixture');
const policy = { granted: ['project.read'], allowedPaths: ['safe'], networkAllowlist: [] };
function home() { return fs.mkdtempSync(path.join(root, 'private-')); }
function config(args = []) { return { transport: 'stdio', command: process.execPath, args: [path.resolve('apps/backend/test/fixtures/mcp-boundary-probe.mjs'), ...args], env: { NODE_OPTIONS: '--allow-fs-read=/', HOME: source, TMPDIR: source } }; }

test('real MCP process reads its scoped snapshot, writes only scratch, and cannot fork or use network', async t => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++;res.end('unexpected'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); });
  const outside = path.join(source, 'outside.txt');
  const command = await prepareMcpStdio({ projectRoot: source, home: home(), server: config([outside, `http://127.0.0.1:${server.address().port}`]), capabilityPolicy: policy, copyProject: true });
  assert.equal(fs.existsSync(path.join(command.cwd, '.env')), false);
  assert.equal(fs.existsSync(path.join(command.cwd, 'outside.txt')), false);
  assert.equal(command.env.NODE_OPTIONS, undefined);
  assert.notEqual(command.env.HOME, source);
  const child = spawn(command.command, command.args, { cwd: command.cwd, env: command.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });child.stderr.on('data', chunk => { stderr += chunk; });
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject);child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(outcome.code, 0, `${stderr}; ${JSON.stringify(outcome)}`);
  const result = JSON.parse(stdout);
  assert.equal(result.copyRead, 'allowed input');
  for (const field of ['copyWriteBlocked', 'outsideReadBlocked', 'outsideWriteBlocked', 'forkBlocked', 'networkBlocked', 'scratchWrite']) assert.equal(result[field], true, field);
  assert.equal(requests, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private outside');
  assert.equal(fs.readFileSync(path.join(source, 'safe/note.txt'), 'utf8'), 'allowed input');
  await confirmMcpStopped(child.pid);
});

test('scoped symlinks and hard links reject before a MCP server is launched', async () => {
  for (const linked of ['symbolic', 'hard']) {
    const destination = path.join(source, 'safe', `${linked}.txt`);
    if (linked === 'symbolic') fs.symlinkSync(path.join(source, 'outside.txt'), destination);
    else fs.linkSync(path.join(source, 'outside.txt'), destination);
    try {
      await assert.rejects(prepareMcpStdio({ projectRoot: source, home: home(), server: config(), capabilityPolicy: policy, copyProject: true }),
        reason => ['MCP_PATH_DENIED', 'MCP_INPUT_RESTRICTED'].includes(reason.code));
    } finally { fs.rmSync(destination); }
  }
});

test('configured code ancestors and dependency symlinks cannot expose the original project', async () => {
  await assert.rejects(prepareMcpStdio({ projectRoot: path.resolve('apps/backend/test/fixtures'), home: home(),
    server: { command: process.execPath, args: [path.resolve('apps/backend/test/agentService.test.js')] } }), { code: 'MCP_CODE_SCOPE_DENIED' });
  const code = path.join(root, 'code');fs.mkdirSync(code);fs.writeFileSync(path.join(code, 'entry.mjs'), '');
  fs.symlinkSync(source, path.join(code, 'node_modules'));
  await assert.rejects(prepareMcpStdio({ projectRoot: source, home: home(),
    server: { command: process.execPath, args: [path.join(code, 'entry.mjs')] } }), { code: 'MCP_CODE_SCOPE_DENIED' });
});

test('a live or unknown retained process cannot be treated as stopped or replaced', async () => {
  const retained = path.join(source, '.scienceprism/mcp-runtime/old');fs.mkdirSync(retained, { recursive: true });
  const owner = path.join(retained, 'process.json');
  for (const record of [{ pid: null, stopConfirmed: false }, { pid: process.pid, stopConfirmed: false }]) {
    fs.writeFileSync(owner, JSON.stringify(record));
    assert.throws(() => assertRetainedMcpStopped(source), { code: 'MCP_STOP_FAILED' });
  }
  await assert.rejects(confirmMcpStopped(process.pid, { timeoutMs: 0 }), { code: 'MCP_STOP_FAILED' });
  assert.equal(fs.existsSync(retained), true);
  fs.rmSync(retained, { recursive: true });
});

test('an actually exited retained PID provides restart proof without launching its old task', async () => {
  const child = spawn(process.execPath, ['-e', '']);await new Promise(resolve => child.once('close', resolve));
  const retained = path.join(source, '.scienceprism/mcp-runtime/dead');fs.mkdirSync(retained, { recursive: true });
  const owner = path.join(retained, 'process.json');fs.writeFileSync(owner, JSON.stringify({ pid: child.pid, stopConfirmed: false }));
  assertRetainedMcpStopped(source);
  assert.equal(JSON.parse(fs.readFileSync(owner, 'utf8')).stopConfirmed, true);
});

test('the actual transport persists an unknown pending owner before it can spawn', async () => {
  const pendingHome=path.join(source,'.scienceprism/mcp-runtime/pending');fs.mkdirSync(pendingHome,{recursive:true});
  const owner=path.join(pendingHome,'process.json');
  const {transport}=await createMcpTransport({projectRoot:source,home:pendingHome,server:config(),beforeRequest:async()=>{},
    onProcess:async record=>{fs.writeFileSync(owner,JSON.stringify(record));if(!record.stopConfirmed)throw new Error('stopped before launch');}});
  try{
    await assert.rejects(transport.start(),/stopped before launch/);
    assert.equal(transport.pid,null);
    assert.deepEqual(JSON.parse(fs.readFileSync(owner,'utf8')),{pid:null,stopConfirmed:false,isolation:'macos-sandbox-exec'});
    assert.throws(()=>assertRetainedMcpStopped(source),{code:'MCP_STOP_FAILED'});
  }finally{await transport.close();}
  assert.equal(JSON.parse(fs.readFileSync(owner,'utf8')).stopConfirmed,true);
});
