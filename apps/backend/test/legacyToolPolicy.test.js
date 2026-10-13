import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyToolPolicy } from '../src/services/harnessRuntime/legacyToolPolicy.js';
import { HarnessRuntimeError } from '../src/services/harnessRuntime/errors.js';

const scopes = () => ({ granted: ['project.read', 'patch.propose', 'research.search'], allowedPaths: [], networkAllowlist: ['export.arxiv.org'] });
const request = (tool = 'read_file', ...paths) => {
  const path = paths.length ? paths[0] : 'papers/main.tex';
  return { tool, callId: 'call-1', ...(path === undefined ? {} : { path }) };
};
async function fixture(options = {}) {
  let policy = { projectId: 'project', runId: 'run', role: 'writer', task: 'writing', version: 'v1', active: true, mode: 'auto',
    capabilities: scopes(), ...options.policy };
  let readingFailure; const decisions = [], effects = [];
  const f = { decisions, effects, policy: () => structuredClone(policy), setPolicy: patch => { policy = { ...policy, ...patch }; },
    setReadingFailure: reason => { readingFailure = reason; } };
  f.gate = await createLegacyToolPolicy({ projectId: 'project', task: 'writing', capabilityPolicy: options.fixed || scopes(), signal: options.signal,
    readPolicy: async () => { if (readingFailure) throw readingFailure; return structuredClone(policy); },
    onDecision: async event => { decisions.push(event); await options.onDecision?.(event, f); } });
  return f;
}

test('read and proposal admissions retain manual semantics and persist actual system decisions', async () => {
  const f = await fixture({ policy: { mode: 'manual' } });
  for (const tool of ['read_file', 'list_files', 'get_compile_log', 'read_research_skill', 'propose_patch', 'apply_patch', 'arxiv_search', 'arxiv_bibtex']) {
    const admission = await f.gate.admit(request(tool, ['arxiv_search', 'arxiv_bibtex'].includes(tool) ? undefined : 'papers/main.tex'));
    const policy = await admission.recheck(); assert.deepEqual(policy.granted, scopes().granted);
    assert.equal(typeof admission.deny, 'function'); f.effects.push(tool);
  }
  assert.equal(f.effects.length, 8); assert.ok(f.decisions.every(value => value.decision === 'allow' && value.actor === 'system' && value.policyVersion === 'v1'));
  assert.equal(f.decisions[0].projectId, 'project'); assert.equal(f.decisions[0].runId, 'run'); assert.equal(f.decisions[0].capability, 'project.read');
});

test('missing trusted hooks, invalid policy shape and initial owner binding fail closed', async () => {
  for (const options of [{}, { readPolicy: async () => ({}) }, { onDecision: async () => {} }]) {
    await assert.rejects(createLegacyToolPolicy(options), { code: 'LEGACY_POLICY_UNAVAILABLE' });
  }
  for (const patch of [{ projectId: 'other' }, { task: 'other' }]) await assert.rejects(fixture({ policy: patch }), { code: 'LEGACY_OWNER_CHANGED' });
  for (const patch of [{ runId: '' }, { role: 'bad\n' }, { mode: 'invalid' }, { active: 'true' }, { version: '' },
    { capabilities: { ...scopes(), allowedPaths: null } }, { capabilities: { ...scopes(), granted: [false] } }]) {
    await assert.rejects(fixture({ policy: patch }), { code: 'LEGACY_POLICY_UNAVAILABLE' });
  }
  const gate = await createLegacyToolPolicy({ capabilityPolicy: { granted: ['project.read'] },
    readPolicy: async () => ({ projectId: 'project', runId: 'run', role: 'writer', task: 'writing', version: 1, active: true, mode: 'manual', capabilities: scopes() }),
    onDecision: async () => {} });
  assert.deepEqual((await (await gate.admit(request())).recheck()).allowedPaths, []);
});

test('exact tool names, bounded identities and normalized paths reject injected authority', async () => {
  const f = await fixture();
  for (const input of [{ ...request(), tool: 'shell' }, { ...request(), tool: 'READ_FILE' }, { ...request(), tool: 'read-file' }]) {
    await assert.rejects(f.gate.admit(input), { code: 'LEGACY_TOOL_NOT_BOUND' });
  }
  for (const input of [{ ...request(), callId: '' }, { ...request(), callId: 'x'.repeat(201) }, { ...request(), callId: 'bad\0' },
    { ...request(), role: 'admin' }, { ...request(), url: 'https://example.org' }, { ...request(), projectId: 'other' }, { ...request(), tool: 'x'.repeat(10000) }]) {
    await assert.rejects(f.gate.admit(input), { code: 'LEGACY_ARGUMENTS_INVALID' });
  }
  for (const tool of ['read_file', 'propose_patch', 'apply_patch']) await assert.rejects(f.gate.admit(request(tool, undefined)), { code: 'PATH_DENIED' });
  for (const path of ['', '../main.tex', 'a/../main.tex', '/main.tex', 'C:/main.tex', 'a\\b', 'a//b', './a', 'a/', 'bad\0', '.env', '.git/config']) {
    await assert.rejects(f.gate.admit(request('read_file', path)), { code: 'PATH_DENIED' });
  }
  assert.equal(f.effects.length, 0); assert.equal(f.decisions.filter(value => value.decision === 'allow').length, 0);
  await (await f.gate.admit(request('list_files', ''))).recheck();
});

test('current project, Run, role, task and activity cannot change the bound executor', async () => {
  for (const patch of [{ projectId: 'other' }, { runId: 'other' }, { role: 'other' }, { task: 'other' }, { active: false }]) {
    const f = await fixture(); f.setPolicy(patch);
    await assert.rejects(f.gate.admit(request()), { code: patch.active === false ? 'LEGACY_RUN_INACTIVE' : 'LEGACY_OWNER_CHANGED' });
    assert.equal(f.decisions.at(-1).decision, 'deny');
  }
  const inactive = await fixture({ policy: { active: false } }); inactive.setPolicy({ active: true });
  await assert.rejects(inactive.gate.admit(request()), { code: 'LEGACY_RUN_INACTIVE' });
});

test('fixed and startup capability ceilings cannot be expanded by a later policy', async () => {
  for (const options of [{ fixed: { ...scopes(), granted: ['project.read'] } }, { policy: { capabilities: { ...scopes(), granted: ['project.read'] } } }]) {
    const f = await fixture(options); f.setPolicy({ capabilities: scopes() });
    await assert.rejects(f.gate.admit(request('propose_patch')), { code: 'CAPABILITY_DENIED' });
    assert.equal(f.decisions.filter(value => value.decision === 'allow').length, 0);
  }
});

test('fresh admissions allow legal narrowing and return three-level scope intersections', async () => {
  const f = await fixture({ fixed: { ...scopes(), allowedPaths: ['papers', 'results'], networkAllowlist: ['export.arxiv.org', 'extra.test'] },
    policy: { capabilities: { ...scopes(), allowedPaths: ['papers/chapter', 'other'] } } });
  f.setPolicy({ version: 'v2', capabilities: { ...scopes(), granted: ['project.read', 'research.search'], allowedPaths: ['papers/chapter/intro', 'results'], networkAllowlist: ['export.arxiv.org', 'new.test'] } });
  const admission = await f.gate.admit(request('read_file', 'papers/chapter/intro/main.tex'));
  const result = await admission.recheck(); assert.deepEqual(result.allowedPaths, ['papers/chapter/intro']);
  assert.deepEqual(result.granted, ['project.read', 'research.search']); assert.deepEqual(result.networkAllowlist, ['export.arxiv.org']);
  result.granted.push('patch.propose'); assert.deepEqual((await admission.recheck()).granted, ['project.read', 'research.search']);
  await assert.rejects(f.gate.admit(request('propose_patch', 'papers/chapter/intro/main.tex')), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(f.gate.admit(request('read_file', 'results/main.tex')), { code: 'PATH_DENIED' });
});

test('disjoint path scopes cannot become unrestricted file capability', async () => {
  const f = await fixture({ fixed: { ...scopes(), allowedPaths: ['papers'] }, policy: { capabilities: { ...scopes(), allowedPaths: ['results'] } } });
  await assert.rejects(f.gate.admit(request()), { code: 'CAPABILITY_DENIED' });
  await assert.rejects(f.gate.admit(request('list_files', undefined)), { code: 'CAPABILITY_DENIED' });
});

test('audit failure prevents admission and deny audit cannot overwrite the original audit error', async () => {
  const f = await fixture({ onDecision: async () => { throw new Error('secret-store'); } });
  await assert.rejects(f.gate.admit(request()), error => error.code === 'LEGACY_AUDIT_UNAVAILABLE' && !error.message.includes('secret-store'));
  assert.equal(f.effects.length, 0); assert.equal(f.decisions.length, 2);
  const denyBroken = await fixture({ onDecision: async event => { if (event.decision === 'deny') throw new Error('deny-store'); } });
  const admission = await denyBroken.gate.admit(request());
  await assert.rejects(admission.deny(new Error('secret')), { code: 'LEGACY_AUDIT_UNAVAILABLE' });
  assert.equal(denyBroken.decisions.at(-1).reasonCode, 'LEGACY_TOOL_FAILED');
});

test('policy version, mode and same-version scope drift during persisted allow stop before operation', async () => {
  for (const patch of [{ version: 'v2' }, { mode: 'manual' }, { capabilities: { ...scopes(), granted: ['project.read'] } },
    { capabilities: { ...scopes(), allowedPaths: ['papers'] } }, { capabilities: { ...scopes(), networkAllowlist: [] } }]) {
    const f = await fixture({ onDecision: async (event, target) => { if (event.decision === 'allow') target.setPolicy(patch); } });
    await assert.rejects(f.gate.admit(request()), { code: 'LEGACY_POLICY_CHANGED' });
    assert.equal(f.effects.length, 0); assert.equal(f.decisions.at(-1).decision, 'deny');
  }
});

test('trusted asynchronous effect hooks recheck paths and policy after queued waits', async () => {
  const f = await fixture({ fixed: { ...scopes(), allowedPaths: ['papers'] } });
  const admission = await f.gate.admit(request());
  await assert.rejects(admission.recheck({ path: 'results/new.tex' }), { code: 'PATH_DENIED' });
  await assert.rejects(admission.recheck({ path: '../secret' }), { code: 'PATH_DENIED' });
  await assert.rejects(admission.recheck({ role: 'admin' }), { code: 'LEGACY_ARGUMENTS_INVALID' });
  await Promise.resolve(); f.setPolicy({ version: 'v2' });
  await assert.rejects(admission.recheck(), { code: 'LEGACY_POLICY_CHANGED' });
  await admission.deny(new HarnessRuntimeError(403, 'LEGACY_POLICY_CHANGED', 'private-message'));
  assert.equal(f.decisions.at(-1).reasonCode, 'LEGACY_POLICY_CHANGED'); assert.equal(JSON.stringify(f.decisions).includes('private-message'), false);
});

test('trusted network hooks require all static, ceiling and current host scopes', async () => {
  const f = await fixture(); const admission = await f.gate.admit(request('arxiv_search', undefined));
  await admission.recheck({ url: 'https://export.arxiv.org/api/query?q=paper' });
  await assert.rejects(admission.recheck({ url: 'https://export.arxiv.org.evil.test/query' }), { code: 'NETWORK_DENIED' });
  await assert.rejects(admission.recheck({ url: 'not a URL' }), { code: 'NETWORK_DENIED' });
  f.setPolicy({ capabilities: { ...scopes(), networkAllowlist: [] } });
  await assert.rejects(admission.recheck({ url: 'https://export.arxiv.org/api/query' }), { code: 'LEGACY_POLICY_CHANGED' });
  for (const options of [{ fixed: { ...scopes(), networkAllowlist: [] } }, { policy: { capabilities: { ...scopes(), networkAllowlist: [] } } }]) {
    const other = await fixture(options); other.setPolicy({ capabilities: scopes() });
    const checked = await other.gate.admit(request('arxiv_search', undefined));
    await assert.rejects(checked.recheck({ url: 'https://export.arxiv.org/api/query' }), { code: 'NETWORK_DENIED' });
  }
  const read = await (await fixture()).gate.admit(request());
  await assert.rejects(read.recheck({ url: 'https://export.arxiv.org/api/query' }), { code: 'NETWORK_DENIED' });
});

test('cancel and inactive owner after admission prevent a pending effect', async () => {
  const controller = new AbortController(), f = await fixture({ signal: controller.signal });
  const admission = await f.gate.admit(request()); controller.abort();
  await assert.rejects(admission.recheck(), { code: 'LEGACY_CANCELLED' });
  await assert.rejects(f.gate.admit(request()), { code: 'LEGACY_CANCELLED' });
  const stopped = await fixture(); const permit = await stopped.gate.admit(request()); stopped.setPolicy({ active: false });
  await assert.rejects(permit.recheck(), { code: 'LEGACY_RUN_INACTIVE' });
});

test('unavailable policy reads are typed and cannot leak provider messages', async () => {
  const f = await fixture(); f.setReadingFailure(new Error('Bearer private-secret'));
  await assert.rejects(f.gate.admit(request()), error => error.code === 'LEGACY_POLICY_UNAVAILABLE' && !error.message.includes('private-secret'));
  assert.equal(f.decisions.at(-1).decision, 'deny');
});
