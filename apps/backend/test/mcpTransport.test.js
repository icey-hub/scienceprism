import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';

const cache = path.resolve('.cache/research-workbench-v2/mcp-tool-policy');
await mkdir(cache, { recursive: true });
const data = await mkdtemp(path.join(cache, 'transport-data-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { saveMcpServer, discoverMcpTools } = await import('../src/services/mcp/index.js');
const { mcpCheckAdapter } = await import('../src/services/mcp/execution.js');
test.after(() => rm(data, { recursive: true, force: true }));
const schema = { type: 'object', properties: { label: { type: 'string', maxLength: 40 } }, required: ['label'] };

async function fixture(t, id) {
  const root = path.join(data, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id }));
  await writeFile(path.join(root, 'note.txt'), 'original');
  const counts = { initialize: 0, list: 0, call: 0 };
  let liveSchema = schema;
  let callHandler = message => ({ content: [{ type: 'text', text: `remote ${message.params.arguments.label}` }] });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') {
      counts.initialize++;
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      counts.list++;
      result = { tools: [{ name: 'read_note', inputSchema: liveSchema, annotations: { readOnlyHint: true } }] };
    } else {
      counts.call++;
      result = await callHandler(message);
    }
    if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  await saveMcpServer(id, { id: 'notes', transport: 'streamable-http', url, enabled: true,
    roles: ['project-agent'], tasks: ['mcp-check'], tools: ['read_note'], capability: 'project.read' });
  assert.equal((await discoverMcpTools(id, 'notes')).servers[0].discovery.state, 'discovered');
  counts.initialize = counts.list = counts.call = 0;
  const capabilities = { granted: ['project.read'], allowedPaths: ['note.txt'], networkAllowlist: ['127.0.0.1'] };
  const current = { projectId: id, runId: 'owned-run', role: 'project-agent', task: 'mcp-check', active: true, mode: 'auto', version: 'v1', capabilities: structuredClone(capabilities) };
  const decisions = [], events = [];
  const options = { request: { projectId: id, role: 'project-agent', task: 'mcp-check', mcpCall: { serverId: 'notes', toolName: 'read_note', arguments: { label: 'checked' } } },
    capabilityPolicy: capabilities, signal: new AbortController().signal, readPolicy: async () => structuredClone(current),
    onDecision: async event => { decisions.push(event); }, emit: event => { events.push(event); } };
  return { root, current, decisions, events, counts, options, server, url,
    setSchema(value) { liveSchema = value; }, setHandler(value) { callHandler = value; } };
}

test('actual HTTP MCP uses validated project.read authority without creating a local process', async t => {
  const f = await fixture(t, 'normal');
  const result = await mcpCheckAdapter.run(f.options);
  assert.match(result.finalResponse, /remote checked/);
  assert.deepEqual(result.patches, []);
  assert.equal(f.counts.call, 1);
  assert.equal(f.decisions[0].actor, 'system');
  assert.equal(f.decisions[0].policyVersion, 'v1');
  assert.equal(f.decisions.some(event => event.type === 'mcp/process'), false);
  assert.deepEqual(await readdir(path.join(f.root, '.scienceprism/mcp-runtime')), []);
});

test('invalid live arguments reject before any HTTP connection or tool call', async t => {
  const f = await fixture(t, 'invalid');
  f.options.request.mcpCall.arguments = { label: 42, role: 'admin' };
  await assert.rejects(mcpCheckAdapter.run(f.options), { code: 'MCP_ARGUMENTS_INVALID' });
  assert.deepEqual(f.counts, { initialize: 0, list: 0, call: 0 });
  assert.equal(f.decisions.at(-1).decision, 'deny');
});

test('live schema drift stops before tools/call and preserves a denied audit', async t => {
  const f = await fixture(t, 'drift');
  f.setSchema({ ...schema, required: [] });
  await assert.rejects(mcpCheckAdapter.run(f.options), { code: 'MCP_SCHEMA_CHANGED' });
  assert.equal(f.counts.call, 0);
  assert.equal(f.decisions.at(-1).decision, 'deny');
});

test('the actual fetch guard prevents dispatch when authority changes after tool/start', async t => {
  const f = await fixture(t, 'fetch-revoke');
  f.options.emit = event => {
    f.events.push(event);
    if (event.type === 'tool/start') { f.current.capabilities.networkAllowlist = []; f.current.version = 'revoked'; }
  };
  await assert.rejects(mcpCheckAdapter.run(f.options), reason => /MCP_POLICY_CHANGED/.test(reason.code || reason.message));
  assert.equal(f.counts.call, 0);
  assert.equal(f.events.some(event => event.type === 'tool/end'), false);
  assert.equal(f.decisions.at(-1).decision, 'deny');
});

test('late provider results are withheld after current policy revocation', async t => {
  const f = await fixture(t, 'late-result');
  f.setHandler(() => { f.current.active = false; return { content: [{ type: 'text', text: 'late data' }] }; });
  await assert.rejects(mcpCheckAdapter.run(f.options), { code: 'MCP_RUN_INACTIVE' });
  assert.equal(f.counts.call, 1);
  assert.equal(f.events.some(event => event.type === 'tool/end'), false);
  assert.equal(f.decisions.at(-1).decision, 'deny');
});

test('an in-flight HTTP tool is cancelled without delivering a late response', async t => {
  const f = await fixture(t, 'cancel');
  let began, release;
  const started = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.setHandler(async () => { began(); await pending; return { content: [{ type: 'text', text: 'late' }] }; });
  const controller = new AbortController();f.options.signal = controller.signal;
  const result = mcpCheckAdapter.run(f.options);
  const outcome = assert.rejects(result);
  await started;controller.abort(new Error('cancelled'));release();await outcome;
  assert.equal(f.events.some(event => event.type === 'tool/end'), false);
  assert.deepEqual(await readdir(path.join(f.root, '.scienceprism/mcp-runtime')), []);
});

test('configured HTTP redirects cannot reach a second endpoint during discovery', async t => {
  const id = 'redirect', root = path.join(data, id);
  await mkdir(root);await writeFile(path.join(root, 'project.json'), '{}');
  let reached = 0;
  const target = createServer((_req, res) => { reached++;res.writeHead(200).end('{}'); });
  const source = createServer((_req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/other` }).end());
  for (const server of [target, source]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); });
  }
  await saveMcpServer(id, { id: 'notes', transport: 'streamable-http', url: `http://127.0.0.1:${source.address().port}/mcp`, enabled: true });
  const result = await discoverMcpTools(id, 'notes');
  assert.equal(result.servers[0].discovery.state, 'failed');assert.equal(reached, 0);
});
