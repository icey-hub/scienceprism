import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCodeScope, createCodeAuthorization, assertCodeAuthorization } from '../src/services/researchAutomation/codeAuthorization.js';
import { ResearchWorkflowError } from '../src/services/researchWorkflow/errors.js';

const scope = () => ({ allowedPaths: ['experiments'], maxTokens: 5000, timeoutMs: 30000, maxVersions: 2 });
const input = () => ({ projectId: 'project-1', session: { id: 'session-1', coordinatorRunId: 'parent-1', status: 'running', stopRequested: false },
  stage: 'replication', inputSha256: 'a'.repeat(64), policyVersion: 3, policy: { enabled: true, overrides: { code: 'inherit' }, codeScope: scope() } });
const reject = (fn, code) => assert.throws(fn, error => error instanceof ResearchWorkflowError && error.code === code);

test('code scope is explicit, nonempty, canonical and budget bounded', () => {
  assert.equal(validateCodeScope(), null); assert.equal(validateCodeScope(null), null);
  assert.deepEqual(validateCodeScope({ ...scope(), allowedPaths: ['scripts', 'experiments', 'scripts'] }), { ...scope(), allowedPaths: ['experiments', 'scripts'] });
  for (const patch of [{ allowedPaths: [] }, { allowedPaths: Array(1) }, { maxTokens: 127 }, { maxTokens: 100001 }, { maxTokens: 5000.5 },
    { timeoutMs: 99 }, { timeoutMs: 600001 }, { timeoutMs: Infinity }, { maxVersions: 0 }, { maxVersions: 3 }, { approved: true }]) {
    reject(() => validateCodeScope({ ...scope(), ...patch }), 'AUTOMATION_CODE_SCOPE_INVALID');
  }
  assert.deepEqual(validateCodeScope({ allowedPaths: ['experiments/run.py'], maxTokens: 128, timeoutMs: 100, maxVersions: 1 }).allowedPaths, ['experiments/run.py']);
});

test('code prefixes reject roots, traversal, broad wildcards, URLs and sensitive storage', () => {
  for (const prefix of ['', '.', '..', '/', '../experiments', 'experiments/../src', 'experiments/', 'experiments//src', 'experiments\\src',
    'C:/src', 'C:src', 'https://example.com/src', '*', 'experiments/*', 'experiments?', '.git', '.scienceprism', '.agents', '.codex',
    '.cache', 'node_modules', 'experiments/.hidden', 'experiments/.env', 'experiments/secret.pem', ' experiments', 'experiments\n', '\ud800']) {
    reject(() => validateCodeScope({ ...scope(), allowedPaths: [prefix] }), 'AUTOMATION_CODE_SCOPE_INVALID');
  }
});

test('grant binds the real coordinator and fixed input without mutating or aliasing policy', () => {
  const current = input(), before = structuredClone(current), auth = createCodeAuthorization(current);
  assert.deepEqual(current, before);
  assert.deepEqual(Object.keys(auth).sort(), ['schemaVersion', 'capability', 'actor', 'projectId', 'sessionId', 'parentRunId', 'stage', 'inputSha256', 'policyVersion', 'scope', 'scopeSha256'].sort());
  assert.equal(auth.capability, 'patch.propose'); assert.equal(auth.actor, 'system'); assert.equal(auth.parentRunId, 'parent-1');
  assert.deepEqual(assertCodeAuthorization(auth, current), scope());
  current.policy.codeScope.allowedPaths.push('other'); assert.deepEqual(auth.scope, scope());
});

test('code switch is independent of execution plans and absent legacy scope grants nothing', () => {
  const current = input();
  for (const patch of [{ enabled: false }, { overrides: { code: 'manual' } }, { overrides: { code: 'unknown' } }]) {
    reject(() => createCodeAuthorization({ ...current, policy: { ...current.policy, ...patch } }), 'AUTOMATION_CODE_DISABLED');
  }
  assert.equal(createCodeAuthorization({ ...current, policy: { ...current.policy, enabled: false, overrides: { code: 'auto' } } }).actor, 'system');
  current.session.executionPlan = { codeScope: scope(), capabilities: ['patch.propose'], approved: true };
  for (const codeScope of [undefined, null]) {
    reject(() => createCodeAuthorization({ ...current, policy: { ...current.policy, codeScope } }), 'AUTOMATION_CODE_SCOPE_REQUIRED');
  }
});

test('stopped sessions and incomplete, foreign or unrelated identities cannot create grants', () => {
  const current = input();
  for (const patch of [{ status: 'stopped' }, { status: 'queued' }, { stopRequested: true }]) {
    reject(() => createCodeAuthorization({ ...current, session: { ...current.session, ...patch } }), 'AUTOMATION_CODE_INACTIVE');
  }
  for (const next of [undefined, { ...current, projectId: '' }, { ...current, stage: 'writing' },
    { ...current, session: { ...current.session, id: ' session-1' } }, { ...current, session: { ...current.session, coordinatorRunId: '' } },
    { ...current, session: { ...current.session, projectId: 'other' } }]) {
    reject(() => createCodeAuthorization(next), 'AUTOMATION_CODE_IDENTITY_INVALID');
  }
  for (const inputSha256 of ['', 'A'.repeat(64), 'a'.repeat(63), null]) {
    reject(() => createCodeAuthorization({ ...current, inputSha256 }), 'AUTOMATION_CODE_INPUT_INVALID');
  }
});

test('existing grants reject project, parent, session and stage replacement or stopped owners', () => {
  const current = input(), auth = createCodeAuthorization(current);
  for (const next of [{ ...current, projectId: 'other' }, { ...current, stage: 'experiment' },
    { ...current, session: { ...current.session, id: 'other' } }, { ...current, session: { ...current.session, coordinatorRunId: 'other' } }]) {
    reject(() => assertCodeAuthorization(auth, next), 'AUTOMATION_CODE_IDENTITY_CHANGED');
  }
  reject(() => assertCodeAuthorization(auth, { ...current, session: { ...current.session, stopRequested: true } }), 'AUTOMATION_CODE_INACTIVE');
});

test('forged authority and extra grant fields are rejected', () => {
  const current = input(), auth = createCodeAuthorization(current);
  for (const patch of [{ schemaVersion: 2 }, { capability: 'experiment.execute' }, { actor: 'human' }, { approved: true }, { sourceRunId: 'model-picked' }]) {
    reject(() => assertCodeAuthorization({ ...auth, ...patch }, current), 'AUTOMATION_CODE_AUTHORIZATION_INVALID');
  }
});

test('original input and canonical scope hashes are checked before reuse', () => {
  const current = input(), auth = createCodeAuthorization(current);
  for (const patch of [{ inputSha256: 'b'.repeat(64) }, { scopeSha256: 'b'.repeat(64) },
    { scope: { ...auth.scope, timeoutMs: 29000 } }, { scope: { ...auth.scope, allowedPaths: ['experiments', 'experiments'] } }]) {
    reject(() => assertCodeAuthorization({ ...auth, ...patch }, current), 'AUTOMATION_CODE_BINDING_CHANGED');
  }
  reject(() => assertCodeAuthorization(auth, { ...current, inputSha256: 'b'.repeat(64) }), 'AUTOMATION_CODE_BINDING_CHANGED');
});

test('current path contraction and each budget reduction revoke the entire original grant', () => {
  const current = input(), auth = createCodeAuthorization(current);
  for (const patch of [{ allowedPaths: ['experiments/sub'] }, { allowedPaths: ['experiments-other'] },
    { maxTokens: 4999 }, { timeoutMs: 29999 }, { maxVersions: 1 }]) {
    reject(() => assertCodeAuthorization(auth, { ...current, policyVersion: 4,
      policy: { ...current.policy, codeScope: { ...scope(), ...patch } } }), 'AUTOMATION_CODE_SCOPE_REVOKED');
  }
  reject(() => assertCodeAuthorization(auth, { ...current, policy: { ...current.policy, overrides: { code: 'manual' } } }), 'AUTOMATION_CODE_DISABLED');
});

test('expanded current policy preserves original limits and returned scope cannot mutate the grant', () => {
  const current = input(), auth = createCodeAuthorization(current), before = structuredClone(auth);
  const returned = assertCodeAuthorization(auth, { ...current, policyVersion: 8,
    policy: { ...current.policy, codeScope: { allowedPaths: ['experiments', 'scripts'], maxTokens: 100000, timeoutMs: 600000, maxVersions: 2 } } });
  assert.deepEqual(returned, scope()); returned.allowedPaths.push('other'); returned.maxTokens = 128;
  assert.deepEqual(auth, before);
  const nested = input(); nested.policy.codeScope.allowedPaths = ['experiments/nested']; const nestedAuth = createCodeAuthorization(nested);
  assert.deepEqual(assertCodeAuthorization(nestedAuth, current), nestedAuth.scope);
});

test('invalid and rolled back policy versions cannot authenticate grants', () => {
  const current = input(), auth = createCodeAuthorization(current);
  for (const policyVersion of [0, -1, NaN, 3.5, '3']) {
    reject(() => createCodeAuthorization({ ...current, policyVersion }), 'AUTOMATION_CODE_VERSION_INVALID');
    reject(() => assertCodeAuthorization({ ...auth, policyVersion }, current), 'AUTOMATION_CODE_VERSION_INVALID');
  }
  reject(() => assertCodeAuthorization(auth, { ...current, policyVersion: 2 }), 'AUTOMATION_CODE_VERSION_INVALID');
});
