import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurrentToolPolicy } from '../src/services/harnessRuntime/currentToolPolicy.js';
import { summarizeEvent } from '../src/services/harnessRuntime/runtimeEvents.js';
const base = { id: 'r', projectId: 'p', attempt: 1, status: 'running', role: 'project-agent', task: 'edit',
  capabilities: { granted: ['project.read', 'patch.propose'], allowedPaths: ['sections'], networkAllowlist: [] } };
test('current tool policy rereads Run/configuration, narrows scopes and stays stable when only audit changes', async () => {
  let current = structuredClone(base); let constraints = {};
  const controller = new AbortController();
  const read = createCurrentToolPolicy({ initialRun: structuredClone(base), getRun: async () => current, readConstraints: async () => constraints, signal: controller.signal });
  const first = await read(); current.updatedAt = 'later'; current.events = [{ type: 'tool/policy' }];
  assert.equal((await read()).version, first.version);
  constraints = { allowedPaths: ['sections/method.tex'], capabilities: ['project.read'] };
  assert.deepEqual((await read()).capabilities, { granted: ['project.read'], allowedPaths: ['sections/method.tex'], networkAllowlist: [] });
  constraints = { allowedPaths: ['data'] }; assert.deepEqual((await read()).capabilities.granted, []);
  constraints = { capabilities: [] }; assert.deepEqual((await read()).capabilities.granted, []);
  constraints = {}; current.capabilities.allowedPaths = ['sections/results.tex'];
  assert.deepEqual((await read()).capabilities.allowedPaths, ['sections/results.tex']);
  controller.abort(); assert.equal((await read()).active, false);
});
test('changed attempt/inactive Run cannot act and invalid new policy fails closed', async () => {
  let current = { ...base, status: 'paused' }; let constraints = {};
  const read = createCurrentToolPolicy({ initialRun: base, getRun: async () => current, readConstraints: async () => constraints, signal: new AbortController().signal });
  assert.equal((await read()).active, false);
  current = { ...base, attempt: 2 }; assert.equal((await read()).active, false);
  constraints = { allowedPaths: '../outside' }; await assert.rejects(read(), { code: 'TOOL_POLICY_INVALID' });
});
test('policy event preserves actor/version/denial and maps the actual file tool capability', () => {
  const event = summarizeEvent({ type: 'tool/policy', projectId: 'p', runId: 'r', callId: 'c', tool: 'project_read_file',
    actor: 'system', decision: 'deny', policyVersion: 'version', reasonCode: 'PATH_DENIED', path: 'denied.md' });
  assert.equal(event.capability, 'project.read'); assert.equal(event.decision, 'deny'); assert.equal(event.actor, 'system');
  assert.equal(event.policyVersion, 'version'); assert.equal(event.reasonCode, 'PATH_DENIED'); assert.equal(event.path, 'denied.md');
});
