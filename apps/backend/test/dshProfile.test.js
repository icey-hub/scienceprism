import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDshProfile, delegateArguments, loadVerifiedDshSdk } from '../src/services/harnessRuntime/dshProfile.js';
import { apply, DSH_TOOL_DEFINITIONS } from '../src/services/harnessRuntime/dshPolicyPlugin.js';
import { createDshToolFixture } from './helpers/dshToolFixture.js';

async function fixture(t, options = {}) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/reader/', import.meta.url));
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'dsh-profile-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); const dshHome = path.join(root, 'controls');
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'main.tex'), 'old');
  let policy = { projectId: 'project', runId: 'run', version: 'v1', role: 'writer', task: 'draft', active: true, mode: 'auto', capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['main.tex'], networkAllowlist: [] } };
  if (options.research) { policy.capabilities.granted.push('research.search'); policy.capabilities.networkAllowlist.push('export.arxiv.org'); }
  if (options.experiment) policy.capabilities.granted.push('experiment.execute');
  const decisions = []; const ctx = createDshToolFixture();
  const profile = await createDshProfile({ workspace, dshHome, provider: options.provider, readPolicy: async () => policy, onDecision: async event => { decisions.push(event); await options.audit?.(event); }, signal: options.signal, delegateCodex: options.delegateCodex, searchPapers: options.searchPapers, experimentOptions: options.experimentOptions });
  t.after(async () => { await ctx.dispose(); await profile.close(); });
  const patch = JSON.parse(await fs.readFile(profile.patchPath, 'utf8'));
  const plugin = patch.at(-1).insert.at(-1);
  const config = JSON.parse(await fs.readFile(plugin.config.configPath, 'utf8'));
  const call = async (message, authorization = `Bearer ${config.token}`) => {
    const response = await fetch(config.endpoint, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(message) });
    return { status: response.status, ...await response.json() };
  };
  return { root, workspace, dshHome, profile, ctx, config, plugin, call, decisions, policy: () => policy, update: value => { policy = { ...policy, ...value }; }, boot: async () => { await apply(ctx, plugin.config); await profile.waitReady(); }, execute: (name, args, callId = 'call-1') => ctx.tools.execute({ name, arguments: args, callId, signal: options.signal || new AbortController().signal }) };
}

test('DSH private profile gates execution on authenticated actual plugin handshake', async t => {
  const f = await fixture(t);
  assert.ok(!f.profile.patchPath.startsWith(`${f.workspace}/`));
  assert.equal((await fs.stat(f.plugin.config.configPath)).mode & 0o777, 0o600);
  assert.equal((await f.call({ method: 'policy' }, 'wrong')).error, 'DSH_BRIDGE_DENIED');
  assert.equal((await f.call({ method: 'execute', tool: 'project_read_file', callId: 'early', arguments: { path: 'main.tex' } })).error, 'DSH_TOOL_NOT_BOUND');
  await f.boot();
  assert.equal((await f.execute('project_read_file', { path: 'main.tex' })).value.content, 'old');
  assert.equal(f.decisions.at(-1).decision, 'allow');
  for (const tool of ['bash', 'run_code', 'mcp__unknown', 'spawn_agent']) assert.equal((await f.execute(tool, {})).isError, true);
  assert.equal((await f.execute('project_read_file', { path: 'main.tex', extra: true })).isError, true);
  assert.equal((await f.execute('project_propose_patch', { path: '.dsh/controls.json', content: 'x', expectedSha256: null })).isError, true);
});

test('DSH delegate and file tools share one queue and pass only trusted call identity plus cancellation', async t => {
  let entered; let finish; let actual;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { delegateCodex: async (args, options) => { actual = { args, options }; entered(); await blocked; return { childRunId: 'child', status: 'completed', reply: 'proposed', output: {} }; } });
  await f.boot();
  const delegation = f.execute('research_delegate_codex', { task: 'Correct main.tex', maxTokens: 512 }, 'sdk-call-17');
  await ready;
  const patch = f.execute('project_propose_patch', { path: 'main.tex', content: 'new', expectedSha256: createHash('sha256').update('old').digest('hex') }, 'sdk-call-18');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await fs.readFile(path.join(f.workspace, 'main.tex'), 'utf8'), 'old');
  assert.deepEqual(actual.args, { task: 'Correct main.tex', maxTokens: 512 });
  assert.equal(actual.options.callId, 'sdk-call-17'); assert.equal(actual.options.signal.aborted, false);
  finish(); assert.equal((await delegation).value.childRunId, 'child'); assert.equal((await patch).value.proposed, true);
  assert.deepEqual(f.decisions.filter(event => event.decision === 'allow').map(event => event.tool), ['research_delegate_codex', 'project_propose_patch']);
});

test('DSH delegation rechecks persisted policy, denies widening fields, and propagates shutdown', async t => {
  let f; let delegated = 0;
  f = await fixture(t, { audit: async event => { if (event.tool === 'research_delegate_codex' && event.decision === 'allow') f.update({ active: false }); }, delegateCodex: async () => { delegated += 1; } });
  await f.boot();
  assert.equal((await f.execute('research_delegate_codex', { task: 'x', command: '/bin/sh' })).isError, true);
  assert.equal((await f.execute('research_delegate_codex', { task: 'x' })).isError, true); assert.equal(delegated, 0);
  const controller = new AbortController(); let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const cancelled = await fixture(t, { signal: controller.signal, delegateCodex: (_args, { signal }) => new Promise(resolve => { started(); signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }); }) });
  await cancelled.boot();
  const operation = cancelled.execute('research_delegate_codex', { task: 'x' }); await waiting;
  controller.abort(); await cancelled.profile.close(); assert.equal((await operation).isError, true);
});

test('DSH configuration rejects unverified packages and delegation schema extensions', async () => {
  await assert.rejects(loadVerifiedDshSdk('/not-installed/dsh.js'), { code: 'DSH_VERSION_UNAVAILABLE' });
  for (const input of [{ task: '' }, { task: 'x', cwd: '/tmp' }, { task: 'x', maxTokens: 1 }, { task: 'x', timeoutMs: Infinity }, { task: 'x', provider: 'other' }]) assert.throws(() => delegateArguments(input), { code: 'DSH_ARGUMENTS_INVALID' });
});

test('actual DSH plugin dispatches search through its authenticated bridge and fixed source hooks', async t => {
  let searches = 0;
  const f = await fixture(t, { research: true, searchPapers: async (projectId, criteria, options) => {
    searches++;
    assert.equal(projectId, 'project');
    await options.beforeRequest({ source: 'arxiv', url: 'https://export.arxiv.org/api/query?search_query=study' });
    await options.beforePersist();
    return { id: 'search-session', projectId, criteria, status: 'completed', createdAt: new Date().toISOString(), candidates: [], sourceResults: [], failures: [] };
  } });
  await f.boot();
  const invoke = args => f.execute('research_search_papers', args, 'search-sdk-call');
  const result = await invoke({ query: 'study', sources: ['arxiv'], pageSize: 2 });
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.searchSessionId, 'search-session');
  assert.equal((await invoke({ query: 'study', sources: ['arxiv'], pageSize: 2 })).value.searchSessionId, 'search-session');
  assert.equal(searches, 1);
  assert.equal((await invoke({ query: 'other' })).isError, true);
  assert.equal(f.decisions.find(event => event.tool === 'research_search_papers').capability, 'research.search');
});

test('DSH raw registration exposes standard object JSON Schemas, not the defineTool author DSL', () => {
  for (const definition of DSH_TOOL_DEFINITIONS) {
    const schema = definition.parameters;
    assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required));
    assert.ok(schema.required.every(key => Object.hasOwn(schema.properties, key)));
    const visit = node => {
      assert.notEqual(node.type, 'json'); assert.notEqual(typeof node.required, 'boolean');
      if (node.oneOf) { assert.deepEqual(node.oneOf.map(branch => branch.type), ['string', 'null']); node.oneOf.forEach(visit); }
      else assert.ok(['object', 'string', 'integer', 'null', 'array', 'boolean'].includes(node.type));
      Object.values(node.properties || {}).forEach(visit);
      if (node.items) visit(node.items);
    };
    visit(schema);
  }
  assert.deepEqual(DSH_TOOL_DEFINITIONS.find(tool => tool.name === 'project_propose_patch').parameters.required, ['path', 'content', 'expectedSha256']);
});

test('actual plugin dispatches a fixed experiment through the private bridge only once', async t => {
  const manifest = { id: 'experiment-run-fixture', projectId: 'project', code: { files: [{ path: 'main.tex' }] }, command: { entrypoint: 'main.tex' } };
  const expectedManifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  let saved = { id: manifest.id, projectId: 'project', manifest, status: 'approved', approval: { decision: 'approve', actor: 'human' } };
  let starts = 0;
  const f = await fixture(t, { experiment: true, experimentOptions: {
    getRun: async () => saved,
    start: async (_projectId, _runId, options) => {
      starts++; saved = { ...saved, status: 'running', executionBinding: options.executionBinding };
      await options.beforeLaunch();
      saved = { ...saved, status: 'completed', execution: { exitCode: 0, process: { pid: null, stopConfirmed: true }, isolation: 'controlled-fixture' } };
      return saved;
    }
  } });
  await f.boot();
  const result = await f.execute('research_run_experiment', { runId: manifest.id, expectedManifestSha256 }, 'experiment-call');
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.experimentRunId, manifest.id);
  assert.equal((await f.execute('research_run_experiment', { runId: manifest.id, expectedManifestSha256 }, 'experiment-call')).value.status, 'completed');
  assert.equal(starts, 1); assert.equal(result.value.evidenceConfirmed, false);
  assert.equal((await f.execute('bash', { command: 'unapproved command' })).isError, true);
});

test('DSH compatible provider pins endpoint/model without secret files and must register before readiness', async t => {
  const f = await fixture(t, { provider: { baseUrl: 'http://127.0.0.1:7864/v1', model: 'global:deepseek-v4.1-flash', apiKey: 'must-not-persist' } });
  const text = await fs.readFile(f.profile.patchPath, 'utf8'); const patch = JSON.parse(text);
  const route = patch.at(-1).insert[0].config.providers['scienceprism-configured'];
  assert.equal(route.api, 'openai-completions'); assert.equal(route.model, undefined);
  assert.deepEqual(route.models, [{ id: 'global:deepseek-v4.1-flash', input: ['text'] }]);
  assert.equal(route.baseURL, 'http://127.0.0.1:7864/v1'); assert.equal(route.retryPolicy.maxRetries, 0);
  assert.ok(!text.includes('must-not-persist'));
  for (const id of ['llm-deepseek', 'session-log-deepseek', 'plugin-package-inventory-deepseek']) assert.ok(patch.some(row => row.id === id && row.disabled));
  f.ctx.llm.listProviders = () => [];
  await assert.rejects(f.boot(), /compatible provider is unavailable/);
  assert.equal((await f.call({ method: 'execute', tool: 'project_read_file', callId: 'missing-provider', arguments: { path: 'main.tex' } })).error, 'DSH_TOOL_NOT_BOUND');
});
