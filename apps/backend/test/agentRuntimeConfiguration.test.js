import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getAgentRuntimeStatus } from '../src/services/agentRuntime.js';

test('runtime status uses the execution version verifier, not existence or a user Desktop path', async t => {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/search-policy/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'configuration-'));
  const previous = process.env.SCIENCEPRISM_HARNESS_SDK;
  t.after(async () => { if (previous === undefined) delete process.env.SCIENCEPRISM_HARNESS_SDK; else process.env.SCIENCEPRISM_HARNESS_SDK = previous; await rm(root, { recursive: true, force: true }); });
  const entry = path.join(root, 'index.js');
  await writeFile(entry, 'export const configured = true;');
  process.env.SCIENCEPRISM_HARNESS_SDK = entry;
  assert.equal((await getAgentRuntimeStatus({ runtime: 'harness' })).harnessConfigured, false);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', version: '0.2.0-rc.2', type: 'module' }));
  for (const name of ['dsh', 'dsh-tools', 'dsh-sdk-minimal', 'dsh-llm-pi-ai']) {
    const directory = path.join(root, 'node_modules', '@deepseek-ai', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.0-rc.2' }));
  }
  const ready = await getAgentRuntimeStatus({ runtime: 'harness' });
  assert.equal(ready.harnessConfigured, true); assert.equal(ready.sdkVersion, '0.2.0-rc.2');
  assert.equal(ready.runtime, 'deepseek-harness'); assert.equal(JSON.stringify(ready).includes(root), false);
  await writeFile(path.join(root, 'node_modules/@deepseek-ai/dsh-tools/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.1' }));
  assert.equal((await getAgentRuntimeStatus({ runtime: 'harness' })).harnessConfigured, false);
});
