import test from 'node:test';
import assert from 'node:assert/strict';
import { installDshPolicyBridge } from '../src/services/harnessRuntime/dshPolicyBridge.js';
import { assertProjectPath } from '../src/services/harnessRuntime/capabilities.js';

// Transport-independent contract harness. The separate repository-local probe
// also loads this product module through the real DSH SDK profile.
function fixture(overrides = {}) {
  const listeners = [], guards = [], decisions = [];
  let bodyCalls = 0;
  const state = {
    projectId: 'project-a', runId: 'run-a', version: 1, role: 'reader', task: 'read-paper', active: true, mode: 'auto',
    capabilities: { granted: ['project.read'], allowedPaths: ['papers'] }
  };
  const binding = {
    name: 'project_read', capability: 'project.read', roles: ['reader'], tasks: ['read-paper'],
    check(execution, policy) {
      const args = execution.arguments;
      if (!args || Object.keys(args).length !== 1 || typeof args.path !== 'string') return false;
      assertProjectPath(args.path, policy.capabilities);
      return true;
    }
  };
  const ctx = {
    tools: { guard(fn) { guards.push(fn); } },
    on(name, fn, options) {
      assert.equal(name, 'tools/pre-execute');
      if (options?.prepend) listeners.unshift(fn); else listeners.push(fn);
    }
  };
  const bridge = installDshPolicyBridge(ctx, {
    readPolicy: () => state, bindings: [binding], onDecision: event => { decisions.push(event); }, ...overrides
  });
  const execution = (options = {}) => Object.freeze({
    name: 'project_read', callId: 'call-a', arguments: Object.freeze({ path: 'papers/main.pdf' }), signal: new AbortController().signal, ...options
  });
  const prepare = async exec => {
    const next = async index => index < listeners.length ? listeners[index](exec, () => next(index + 1)) : { kind: 'allow' };
    return next(0);
  };
  const dispatch = exec => {
    if (exec.signal.aborted) return { kind: 'cancel' };
    for (const guard of guards) {
      const reason = guard(exec);
      if (reason !== undefined) return { kind: 'deny', reason };
    }
    bodyCalls += 1;
    return { kind: 'executed' };
  };
  const run = async (exec = execution()) => {
    const result = await prepare(exec);
    return result.kind === 'allow' ? dispatch(exec) : result;
  };
  return { ctx, bridge, state, binding, decisions, execution, prepare, dispatch, run, get bodyCalls() { return bodyCalls; } };
}

test('DSH automatic policy runs once without asking and records system authorization', async () => {
  let asked = 0;
  const f = fixture({ requestApproval() { asked += 1; throw new Error('must not ask'); } });
  assert.equal((await f.run()).kind, 'executed');
  assert.equal(f.bodyCalls, 1); assert.equal(asked, 0);
  assert.equal(f.decisions[0].actor, 'system'); assert.equal(f.decisions[0].policyVersion, 1);
});

test('DSH exact binding rejects unknown names, wrong roles/tasks, scope and schema before dispatch', async () => {
  const f = fixture();
  for (const name of ['filesystem_read', 'project_read_extra', 'bash', 'mcp__read']) {
    assert.equal((await f.run(f.execution({ name }))).kind, 'deny');
  }
  for (const path of ['../secrets', '/etc/passwd', 'papers/.env', 'other/paper.pdf']) {
    assert.equal((await f.run(f.execution({ arguments: { path } }))).kind, 'deny');
  }
  assert.equal((await f.run(f.execution({ arguments: { path: 'papers/a.pdf', ignored: true } }))).kind, 'deny');
  f.state.role = 'writer'; assert.equal((await f.run()).kind, 'deny');
  f.state.role = 'reader'; f.state.task = 'write-paper'; assert.equal((await f.run()).kind, 'deny');
  assert.equal(f.bodyCalls, 0);
});

test('DSH final guard prevents a foreign listener from replacing denial with allow or skipping the bridge', async () => {
  const skipped = fixture();
  skipped.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true });
  assert.equal((await skipped.run()).kind, 'deny'); assert.equal(skipped.bodyCalls, 0);
  const overridden = fixture();
  overridden.ctx.on('tools/pre-execute', async (_exec, next) => { await next(); return { kind: 'allow' }; }, { prepend: true });
  overridden.state.capabilities.granted = [];
  assert.equal((await overridden.run()).kind, 'deny'); assert.equal(overridden.bodyCalls, 0);
});

test('DSH manual mode fails closed without a channel and rejects stale or nonhuman approvals', async () => {
  const missing = fixture(); missing.state.mode = 'manual';
  assert.equal((await missing.run()).info.code, 'DSH_APPROVAL_UNAVAILABLE');
  for (const approval of [null, { decision: 'approve', actor: 'system', policyVersion: 1 }, { decision: 'approve', actor: 'human', policyVersion: 0 }]) {
    const f = fixture({ requestApproval: async () => approval }); f.state.mode = 'manual';
    assert.equal((await f.run()).kind, 'deny'); assert.equal(f.bodyCalls, 0);
  }
  const valid = fixture({ requestApproval: async ({ policy }) => ({ decision: 'approve', actor: 'human', policyVersion: policy.version }) });
  valid.state.mode = 'manual'; assert.equal((await valid.run()).kind, 'executed');
  assert.equal(valid.decisions[0].actor, 'human');
});

test('DSH cancellation before dispatch or during approval executes no body', async () => {
  const initial = fixture(), signal = new AbortController(); signal.abort();
  assert.equal((await initial.run(initial.execution({ signal: signal.signal }))).kind, 'cancel');
  const during = new AbortController();
  const f = fixture({ requestApproval: async () => {
    during.abort(); return { decision: 'approve', actor: 'human', policyVersion: 1 };
  } }); f.state.mode = 'manual';
  assert.equal((await f.run(f.execution({ signal: during.signal }))).kind, 'cancel');
  assert.equal(initial.bodyCalls + f.bodyCalls, 0);
});

test('DSH policy change, revocation and Run reassignment invalidate prepared authorization', async () => {
  const mutations = [
    state => { state.version += 1; }, state => { state.capabilities.granted = []; },
    state => { state.mode = 'manual'; }, state => { state.active = false; },
    state => { state.runId = 'run-b'; }, state => { state.capabilities.allowedPaths = ['other']; }
  ];
  for (const mutate of mutations) {
    const f = fixture(), exec = f.execution();
    assert.equal((await f.prepare(exec)).kind, 'allow'); mutate(f.state);
    assert.equal(f.dispatch(exec).kind, 'deny'); assert.equal(f.bodyCalls, 0);
  }
});

test('DSH rechecks policy after async downstream gates and cannot override their denial', async () => {
  const f = fixture();
  f.ctx.on('tools/pre-execute', async () => { f.state.version += 1; return { kind: 'allow' }; });
  assert.equal((await f.run()).info.code, 'DSH_POLICY_CHANGED'); assert.equal(f.bodyCalls, 0);
  const denied = fixture();
  denied.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'another owner denied' }));
  denied.ctx.on('tools/pre-execute', async (_exec, next) => { await next(); return { kind: 'allow' }; }, { prepend: true });
  assert.equal((await denied.run()).kind, 'deny'); assert.equal(denied.bodyCalls, 0);
});

test('DSH closing the bridge cancels pending approvals and keeps a denial guard installed', async () => {
  let unblock, entered, suppliedSignal;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture({ requestApproval: ({ signal }) => {
    suppliedSignal = signal; entered(); return new Promise(resolve => { unblock = resolve; });
  } }); f.state.mode = 'manual';
  const pending = f.run(); await ready; f.bridge.close();
  assert.equal(suppliedSignal.aborted, true);
  unblock({ decision: 'approve', actor: 'human', policyVersion: 1 });
  assert.equal((await pending).kind, 'cancel');
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true });
  assert.equal((await f.run()).kind, 'deny'); assert.equal(f.bodyCalls, 0);
});

test('DSH policy and recording failures fail closed without leaking internal error details', async () => {
  for (const readPolicy of [() => { throw new Error('private-token'); }, async () => { throw new Error('private-token'); }]) {
    const f = fixture({ readPolicy }); const result = await f.run();
    assert.equal(result.kind, 'deny'); assert.doesNotMatch(result.reason, /private-token/); assert.equal(f.bodyCalls, 0);
  }
  const record = fixture({ onDecision() { throw new Error('private-token'); } });
  assert.equal((await record.run()).kind, 'deny'); assert.equal(record.bodyCalls, 0);
  const changed = fixture({ onDecision() { changed.state.capabilities.granted = []; } });
  assert.equal((await changed.run()).kind, 'deny'); assert.equal(changed.bodyCalls, 0);
  const malformed = fixture(); malformed.state.capabilities.allowedPaths = 'papers';
  assert.equal((await malformed.run()).kind, 'deny'); assert.equal(malformed.bodyCalls, 0);
});

test('DSH bridge installation rejects missing final guard and ambiguous bindings', () => {
  assert.throws(() => installDshPolicyBridge({ on() {} }, { readPolicy() {}, bindings: [] }), /tools.guard/);
  assert.throws(() => fixture({ bindings: [{ name: 'read', capability: 'project.read' }] }), /explicit capability/);
  const f = fixture();
  assert.throws(() => fixture({ bindings: [f.binding, f.binding] }), /explicit capability/);
});
