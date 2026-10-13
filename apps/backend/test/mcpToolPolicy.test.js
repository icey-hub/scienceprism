import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolPolicy } from '../src/services/mcp/toolPolicy.js';
import { HarnessRuntimeError } from '../src/services/harnessRuntime/errors.js';

const scopes = () => ({ granted: ['project.read'], allowedPaths: [], networkAllowlist: ['mcp.example.org'] });
const schema = { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['path'], additionalProperties: false };
const call = patch => ({ callId: 'call', tool: 'read_document', schema: structuredClone(schema), arguments: { path: 'papers/main.tex', limit: 2 }, serverId: 'server', serverVersion: 'v1', ...patch });
async function fixture(options = {}) {
  let policy = { projectId: 'project', runId: 'run', role: 'reader', task: 'reading', version: 'v1', active: true, mode: 'auto', capabilities: scopes(), ...options.policy };
  let failure; const decisions = [], effects = [];
  const f = { policy: () => structuredClone(policy), setPolicy: patch => { policy = { ...policy, ...patch }; }, setFailure: value => { failure = value; }, decisions, effects };
  f.gate = await createMcpToolPolicy({ projectId: 'project', role: 'reader', task: 'reading', capabilityPolicy: options.fixed || scopes(), signal: options.signal,
    readPolicy: async () => { if (failure) throw failure; return structuredClone(policy); }, onDecision: async event => { decisions.push(event); await options.onDecision?.(event, f); } });
  return f;
}

test('one selected MCP call strictly validates its schema, audits, and rechecks project.read HTTP authority', async () => {
  const f = await fixture(), input = call(); const admission = await f.gate.admit(input);
  const policy = await admission.recheck({ url: 'https://mcp.example.org/mcp' });
  assert.deepEqual(policy.granted, ['project.read']); assert.deepEqual(input.schema, schema); assert.deepEqual(input.arguments, { path: 'papers/main.tex', limit: 2 });
  f.effects.push('dispatch'); assert.equal(f.effects.length, 1);
  assert.deepEqual(f.decisions[0], { type: 'tool/policy', tool: 'read_document', callId: 'call', serverId: 'server', serverVersion: 'v1',
    projectId: 'project', runId: 'run', actor: 'system', capability: 'project.read', policyVersion: 'v1', decision: 'allow' });
});

test('undeclared authority, extra root fields and invalid schema values never admit an operation', async () => {
  const f = await fixture();
  for (const argumentsValue of [{ path: 'papers/a', role: 'admin' }, { path: 'papers/a', cmd: 'cat /etc/passwd' }, { path: 'papers/a', projectId: 'other' },
    { path: 'papers/a', limit: 0 }, { path: 'papers/a', limit: '2' }, { limit: 2 }, { path: '' }, []]) {
    await assert.rejects(f.gate.admit(call({ arguments: argumentsValue })), { code: 'MCP_ARGUMENTS_INVALID' });
  }
  await assert.rejects(f.gate.admit({ ...call(), role: 'admin' }), { code: 'MCP_ARGUMENTS_INVALID' });
  assert.equal(f.decisions.filter(value => value.decision === 'allow').length, 0); assert.equal(f.effects.length, 0);
});

test('AJV preserves enum, format, pattern, array, reference, nested and conditional constraints', async () => {
  const f = await fixture();
  const complex = { type: 'object', definitions: { record: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'], additionalProperties: false } },
    properties: { mode: { enum: ['a', 'b'] }, label: { type: 'string', pattern: '^ok-' }, rows: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { $ref: '#/definitions/record' } },
      count: { type: 'integer', multipleOf: 2, minimum: 0 }, flag: { type: 'boolean' } }, required: ['mode', 'label', 'rows', 'count'],
    if: { properties: { mode: { const: 'a' } }, required: ['mode'] }, then: { required: ['flag'] } };
  const valid = { mode: 'a', label: 'ok-label', rows: [{ email: 'reader@example.org' }], count: 2, flag: true };
  await f.gate.admit(call({ schema: complex, arguments: valid }));
  for (const patch of [{ mode: 'c' }, { label: 'bad' }, { rows: [] }, { rows: [{ email: 'invalid' }] }, { rows: [{ email: 'a@example.org', role: 'admin' }] }, { count: 3 }, { flag: undefined }]) {
    const argumentsValue = { ...valid, ...patch }; if (argumentsValue.flag === undefined) delete argumentsValue.flag;
    await assert.rejects(f.gate.admit(call({ schema: complex, arguments: argumentsValue })), { code: 'MCP_ARGUMENTS_INVALID' });
  }
});

test('legal composed and conditional schemas keep their declared semantics without inventing closure', async () => {
  const f = await fixture();
  for (const composed of [
    { type: 'object', allOf: [{ properties: { label: { type: 'string' } }, required: ['label'] }] },
    { type: 'object', oneOf: [{ properties: { label: { const: 'x' } }, required: ['label'] }, { properties: { count: { type: 'number' } }, required: ['count'] }] },
    { type: 'object', definitions: { input: { properties: { label: { type: 'string' } }, required: ['label'] } }, $ref: '#/definitions/input' },
    { type: 'object', if: { properties: { label: { const: 'x' } } }, then: { required: ['label'] } }
  ]) {
    await f.gate.admit(call({ schema: composed, arguments: { label: 'x' } }));
  }
  // A data argument named role cannot change the bound project/Run authority.
  const input = call({ schema: { type: 'object' }, arguments: { role: 'admin', projectId: 'other' } });
  const admission = await f.gate.admit(input);
  assert.deepEqual((await admission.recheck()).granted, ['project.read']);
  assert.equal(f.decisions.at(-1).projectId, 'project');assert.equal(f.decisions.at(-1).runId, 'run');
});

test('unsupported declarations, unknown keywords and remote refs are rejected before audit allow', async () => {
  const f = await fixture();
  for (const inputSchema of [{ ...schema, unknownConstraint: true }, { ...schema, $async: true }, { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' },
    { ...schema, properties: { path: { $ref: 'https://attacker.test/schema' } } }, { ...schema, definitions: { hidden: { $ref: 'file:///etc/passwd' } } },
    { type: 'object', properties: { nested: { type: 'object', properties: { field: { type: 'unsupported' } } } } }, { type: 'string' }]) {
    await assert.rejects(f.gate.admit(call({ schema: inputSchema })), { code: 'MCP_SCHEMA_INVALID' });
  }
  assert.equal(f.decisions.filter(value => value.decision === 'allow').length, 0);
});

test('argument and schema byte, depth and JSON shape bounds reject oversized or non-JSON input', async () => {
  const f = await fixture();
  await assert.rejects(f.gate.admit(call({ arguments: { path: '界'.repeat(8000) } })), { code: 'MCP_ARGUMENTS_INVALID' });
  await assert.rejects(f.gate.admit(call({ schema: { ...schema, description: '界'.repeat(25000) } })), { code: 'MCP_SCHEMA_INVALID' });
  let deep = { type: 'string' }; for (let index = 0; index < 30; index++) deep = { type: 'object', properties: { value: deep } };
  await assert.rejects(f.gate.admit(call({ schema: deep })), { code: 'MCP_SCHEMA_INVALID' });
  const circular = {}; circular.self = circular;
  for (const value of [circular, { path: undefined }, { path: new Date() }, { path: NaN }, JSON.parse('{"__proto__":{"admin":true}}')]) {
    await assert.rejects(f.gate.admit(call({ arguments: value })), { code: 'MCP_ARGUMENTS_INVALID' });
  }
});

test('trusted project, role, task, callbacks and current policy shape are required', async () => {
  await assert.rejects(createMcpToolPolicy({}), { code: 'MCP_POLICY_UNAVAILABLE' });
  for (const patch of [{ projectId: 'other' }, { role: 'other' }, { task: 'other' }]) await assert.rejects(fixture({ policy: patch }), { code: 'MCP_OWNER_CHANGED' });
  for (const patch of [{ runId: '' }, { version: null }, { mode: 'invalid' }, { active: 1 }, { capabilities: { ...scopes(), allowedPaths: null } }]) {
    await assert.rejects(fixture({ policy: patch }), { code: 'MCP_POLICY_UNAVAILABLE' });
  }
  await assert.rejects(fixture({ fixed: { ...scopes(), allowedPaths: ['../private'] } }), { code: 'PATH_DENIED' });
});

test('current Run identities, activation and project.read ceilings cannot be bypassed', async () => {
  for (const patch of [{ projectId: 'other' }, { runId: 'other' }, { task: 'other' }, { role: 'other' }, { active: false }, { capabilities: { ...scopes(), granted: [] } }]) {
    const f = await fixture(); f.setPolicy(patch);
    await assert.rejects(f.gate.admit(call()), error => ['MCP_OWNER_CHANGED', 'MCP_RUN_INACTIVE', 'CAPABILITY_DENIED'].includes(error.code));
    assert.equal(f.decisions.filter(value => value.decision === 'allow').length, 0);
  }
  for (const options of [{ fixed: { ...scopes(), granted: [] } }, { policy: { capabilities: { ...scopes(), granted: [] } } }]) {
    const f = await fixture(options); f.setPolicy({ capabilities: scopes() });
    await assert.rejects(f.gate.admit(call()), { code: 'CAPABILITY_DENIED' });
  }
});

test('legal narrowing returns private-copy path intersection and disjoint scopes deny read', async () => {
  const f = await fixture({ fixed: { ...scopes(), allowedPaths: ['papers', 'results'] }, policy: { capabilities: { ...scopes(), allowedPaths: ['papers/chapter', 'other'] } } });
  f.setPolicy({ version: 'v2', capabilities: { ...scopes(), allowedPaths: ['papers/chapter/intro', 'results'] } });
  const admission = await f.gate.admit(call()), effective = await admission.recheck();
  assert.deepEqual(effective.allowedPaths, ['papers/chapter/intro']); effective.allowedPaths.push('private');
  assert.deepEqual((await admission.recheck()).allowedPaths, ['papers/chapter/intro']);
  const disjoint = await fixture({ fixed: { ...scopes(), allowedPaths: ['papers'] }, policy: { capabilities: { ...scopes(), allowedPaths: ['results'] } } });
  await assert.rejects(disjoint.gate.admit(call()), { code: 'CAPABILITY_DENIED' });
});

test('audit failure or policy drift during allow stops admission and preserves the audit error', async () => {
  const broken = await fixture({ onDecision: async () => { throw new Error('private-secret'); } });
  await assert.rejects(broken.gate.admit(call()), error => error.code === 'MCP_AUDIT_UNAVAILABLE' && !error.message.includes('private-secret'));
  assert.equal(broken.effects.length, 0); assert.equal(broken.decisions.length, 2);
  for (const patch of [{ version: 'v2' }, { mode: 'manual' }, { capabilities: { ...scopes(), networkAllowlist: [] } }, { active: false }]) {
    const f = await fixture({ onDecision: async (event, target) => { if (event.decision === 'allow') target.setPolicy(patch); } });
    await assert.rejects(f.gate.admit(call()), error => ['MCP_POLICY_CHANGED', 'MCP_RUN_INACTIVE'].includes(error.code));
    assert.equal(f.effects.length, 0); assert.equal(f.decisions.at(-1).decision, 'deny');
  }
});

test('recheck pins policy, exact selected server/tool/schema/arguments and call identity across awaits', async () => {
  for (const mutation of ['arguments', 'schema', 'serverId', 'serverVersion', 'tool', 'callId']) {
    const f = await fixture(), input = call(), admission = await f.gate.admit(input); await Promise.resolve();
    if (mutation === 'arguments') input.arguments.path = 'private'; else if (mutation === 'schema') input.schema.additionalProperties = true;
    else input[mutation] = 'changed';
    await assert.rejects(admission.recheck(), { code: 'MCP_BINDING_CHANGED' });
    await admission.deny(new HarnessRuntimeError(403, 'MCP_BINDING_CHANGED', 'secret'));
    assert.equal(f.decisions.at(-1).tool, 'read_document'); assert.equal(f.decisions.at(-1).callId, 'call');
  }
  const f = await fixture(), admission = await f.gate.admit(call()); f.setPolicy({ version: 'v2' });
  await assert.rejects(admission.recheck(), { code: 'MCP_POLICY_CHANGED' });
  await assert.rejects(admission.recheck({ path: 'private' }), { code: 'MCP_ARGUMENTS_INVALID' });
});

test('HTTP guard uses three host ceilings without requiring research.search', async () => {
  const f = await fixture(), admission = await f.gate.admit(call());
  await admission.recheck({ url: 'http://mcp.example.org:8080/mcp' });
  for (const url of ['https://mcp.example.org.evil.test/mcp', 'https://user:password@mcp.example.org/mcp', 'file://mcp.example.org/file', 'invalid']) {
    await assert.rejects(admission.recheck({ url }), { code: 'NETWORK_DENIED' });
  }
  for (const options of [{ fixed: { ...scopes(), networkAllowlist: [] } }, { policy: { capabilities: { ...scopes(), networkAllowlist: [] } } }]) {
    const other = await fixture(options); other.setPolicy({ capabilities: scopes() }); const permit = await other.gate.admit(call());
    await assert.rejects(permit.recheck({ url: 'https://mcp.example.org/mcp' }), { code: 'NETWORK_DENIED' });
  }
  f.setPolicy({ capabilities: { ...scopes(), networkAllowlist: [] } });
  await assert.rejects(admission.recheck({ url: 'https://mcp.example.org/mcp' }), { code: 'MCP_POLICY_CHANGED' });
});

test('cancellation, policy read errors and denied-audit failures are typed and fail closed', async () => {
  const controller = new AbortController(), f = await fixture({ signal: controller.signal }), admission = await f.gate.admit(call());
  controller.abort(); await assert.rejects(admission.recheck(), { code: 'MCP_CANCELLED' }); await assert.rejects(f.gate.admit(call()), { code: 'MCP_CANCELLED' });
  const unavailable = await fixture(); unavailable.setFailure(new Error('Bearer private-secret'));
  await assert.rejects(unavailable.gate.admit(call()), error => error.code === 'MCP_POLICY_UNAVAILABLE' && !error.message.includes('private-secret'));
  const denied = await fixture({ onDecision: async event => { if (event.decision === 'deny') throw new Error('private-secret'); } });
  await assert.rejects((await denied.gate.admit(call())).deny(new Error('secret')), { code: 'MCP_AUDIT_UNAVAILABLE' });
});
