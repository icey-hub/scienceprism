import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deepseekHarnessAdapter } from '../src/services/harnessRuntime/adapters/deepseekAdapter.js';

test('DSH requires executor limits before SDK initialization and rejects invalid or absent budgets', async () => {
  for (const limits of [undefined, {}, { maxTokens: 10, timeoutMs: Infinity }, { maxTokens: NaN, timeoutMs: 10 }, { maxTokens: 0, timeoutMs: 10 }, { maxTokens: 10, timeoutMs: -1 }, { maxTokens: '10', timeoutMs: 10 }]) {
    await assert.rejects(deepseekHarnessAdapter.run({ request: { limits: { maxTokens: 99999, timeoutMs: 99999 } }, limits }), { code: 'DSH_LIMITS_INVALID' });
  }
});

test('DSH passes executor ceilings to the SDK and provider despite larger request/env budgets', async t => {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/reader/', import.meta.url));
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'dsh-limit-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); const sdk = path.join(root, 'sdk');
  await fs.mkdir(workspace); await fs.mkdir(sdk);
  await fs.writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', version: '0.2.0-rc.2', type: 'module' }));
  for (const name of ['dsh', 'dsh-tools', 'dsh-sdk-minimal', 'dsh-llm-pi-ai']) {
    const directory = path.join(sdk, 'node_modules', '@deepseek-ai', name); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.0-rc.2' }));
  }
  const entry = path.join(sdk, 'index.js');
  await fs.writeFile(entry, `
    import {readFile} from 'node:fs/promises';
    import {createDshToolFixture} from ${JSON.stringify(new URL('./helpers/dshToolFixture.js', import.meta.url).href)};
    import {apply} from ${JSON.stringify(new URL('../src/services/harnessRuntime/dshPolicyPlugin.js', import.meta.url).href)};
    export const captured = {};
    export class DeepSeekHarness {
      constructor(options) { captured.sdk = options; this.ctx = createDshToolFixture(); this.client={start(){captured.spawned=true;},child:{pid:process.pid}}; }
      async start() {
        const patch = JSON.parse(await readFile(captured.sdk.patches[0], 'utf8'));
        const entries = patch.at(-1).insert;
        captured.provider = entries[0].config.providers['scienceprism-configured'];
        captured.bridge = JSON.parse(await readFile(entries.at(-1).config.configPath, 'utf8'));
        await apply(this.ctx, entries.at(-1).config);
      }
      async run() { captured.ran = true; return {events:[],finalResponse:'fixture',sessionId:'fixture-session'}; }
      async close() { await this.ctx.dispose(); }
    }
  `);
  const keys = ['SCIENCEPRISM_HARNESS_SDK', 'SCIENCEPRISM_HARNESS_MAX_TOKENS', 'SCIENCEPRISM_HARNESS_TIMEOUT_MS'];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = entry; process.env[keys[1]] = '999999'; process.env[keys[2]] = '999999';
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  const policy = { projectId: 'project', runId: 'run', role: 'writer', task: 'draft', version: 'v1', active: true, mode: 'auto', capabilities: { granted: ['project.read'], allowedPaths: [], networkAllowlist: [] } };
  const processStates = [];
  const result = await deepseekHarnessAdapter.run({ request: { projectId: 'project', task: 'draft', limits: { maxTokens: 888888, timeoutMs: 888888 }, llmConfig: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: 'fixture-only' } },
    limits: { maxTokens: 512, timeoutMs: 1234 }, workspace, dshHome: path.join(root, 'controls'), capabilities: ['project.read'], readPolicy: async () => policy,
    onProcess: async value => { const { captured } = await import(pathToFileURL(entry).href); if (!value.stopConfirmed) assert.notEqual(captured.ran, true); processStates.push(value); }, onDecision: async () => {}, emit: () => {} });
  const { captured } = await import(pathToFileURL(entry).href);
  assert.equal(result.ok, true); assert.equal(captured.ran, true);
  assert.equal(captured.sdk.maxTokens, 512); assert.equal(captured.sdk.requestTimeoutMs, 1234); assert.equal(captured.sdk.initializeTimeoutMs, 1234);
  assert.equal(captured.provider.timeoutMs, 1234); assert.equal(captured.bridge.timeoutMs, 1234);
  assert.deepEqual(processStates, [{ pid: null, stopConfirmed: false }, { pid: process.pid, stopConfirmed: false }, { pid: process.pid, stopConfirmed: true }]);
});
