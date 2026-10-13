import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironmentScope, validateEnvironmentProposal, createEnvironmentAuthorization, assertEnvironmentAuthorization } from '../src/services/researchAutomation/environmentAuthorization.js';
import { ResearchWorkflowError } from '../src/services/researchWorkflow/errors.js';

const scope = () => ({ allowedPaths: ['dependencies'], maxPackages: 2, maxPrepareMs: 5000, maxOutputBytes: 8192, maxEnvironments: 2 });
const context = () => ({ projectId: 'project-1', session: { id: 'session-1', coordinatorRunId: 'parent-1', status: 'running', stopRequested: false },
  stage: 'replication', policyVersion: 3, policy: { enabled: true, overrides: { environment: 'inherit' }, environmentScope: scope() },
  proposal: { packages: [{ path: 'dependencies/example-1.0-py3-none-any.whl', sha256: 'a'.repeat(64) }] }, sourceRunId: 'source-1' });
const reject = (fn, code) => assert.throws(fn, error => error instanceof ResearchWorkflowError && error.code === code);

test('environment scope is explicit, canonical and bounded; absent old policy grants nothing', () => {
  assert.equal(validateEnvironmentScope(), null); assert.equal(validateEnvironmentScope(null), null);
  assert.deepEqual(validateEnvironmentScope({ ...scope(), allowedPaths: ['wheels', 'dependencies', 'wheels'] }), { ...scope(), allowedPaths: ['dependencies', 'wheels'] });
  assert.deepEqual(validateEnvironmentScope({ ...scope(), allowedPaths: [], maxPackages: 0 }).allowedPaths, []);
  for (const change of [{ allowedPaths: Array(1) }, { allowedPaths: [''] }, { maxPackages: -1 }, { maxPackages: 31 },
    { maxPackages: 1.5 }, { maxPrepareMs: 99 }, { maxPrepareMs: 600001 }, { maxOutputBytes: 1023 },
    { maxOutputBytes: 2 * 1024 * 1024 + 1 }, { maxEnvironments: 0 }, { maxEnvironments: 4 }, { maxEnvironments: Infinity }, { actor: 'model' }]) {
    reject(() => validateEnvironmentScope({ ...scope(), ...change }), 'AUTOMATION_ENVIRONMENT_SCOPE_INVALID');
  }
});

test('scope prefixes reject traversal, roots, noncanonical paths and sensitive storage', () => {
  for (const value of ['../wheels', '/wheels', 'wheels/../lib', 'wheels/', '.', 'wheels//lib', 'wheels\\lib', 'C:/wheels', 'C:wheels',
    '.scienceprism', 'lib/.env', 'lib/secret.pem', '.git', '.cache', 'node_modules', 'wheels/*', 'wheels?', ' wheels', 'wheels\n']) {
    reject(() => validateEnvironmentScope({ ...scope(), allowedPaths: [value] }), 'AUTOMATION_ENVIRONMENT_SCOPE_INVALID');
  }
});

test('model proposal only accepts the existing fixed local wheel configuration with no authority or budget', () => {
  const original = context().proposal;
  assert.deepEqual(validateEnvironmentProposal(original), original);
  assert.deepEqual(validateEnvironmentProposal({ packages: [] }), { packages: [] });
  for (const input of [{}, { packages: [] , actor: 'system' }, { ...original, timeoutMs: 100 }, { ...original, maxOutputBytes: 1024 },
    { ...original, allowedPaths: ['dependencies'] }, { ...original, capabilities: ['environment.prepare'] },
    { packages: [{ ...original.packages[0], path: '../file.whl' }] }, { packages: [{ ...original.packages[0], path: 'lib/.env/file.whl' }] },
    { packages: [{ ...original.packages[0], path: 'code.py' }] }, { packages: [{ ...original.packages[0], sha256: 'A'.repeat(64) }] },
    { packages: [original.packages[0], original.packages[0]] }, { packages: [original.packages[0], { ...original.packages[0], path: 'other/example-1.0-py3-none-any.whl' }] },
    { packages: [{ ...original.packages[0], url: 'https://example.com/file.whl' }] }]) {
    reject(() => validateEnvironmentProposal(input), 'AUTOMATION_ENVIRONMENT_PROPOSAL_INVALID');
  }
});

test('grant binds real parent/source and original request without mutating source inputs', () => {
  const input = context(), before = structuredClone(input), auth = createEnvironmentAuthorization(input);
  assert.deepEqual(input, before);
  assert.equal(auth.capability, 'environment.prepare'); assert.equal(auth.actor, 'system'); assert.equal(auth.schemaVersion, 1);
  assert.equal(auth.parentRunId, 'parent-1'); assert.equal(auth.sourceRunId, 'source-1'); assert.equal(auth.policyVersion, 3);
  assert.deepEqual(assertEnvironmentAuthorization(auth, input), { environmentRequest: { ...input.proposal, timeoutMs: 5000, maxOutputBytes: 8192 }, currentPolicyVersion: 3 });
});

test('standard-library-only path scope never inherits the shared empty-list wildcard', () => {
  const input = context(); input.policy.environmentScope.allowedPaths = [];
  reject(() => createEnvironmentAuthorization(input), 'AUTOMATION_ENVIRONMENT_PATH_DENIED');
  input.proposal.packages = [];
  const auth = createEnvironmentAuthorization(input);
  assert.deepEqual(assertEnvironmentAuthorization(auth, input).environmentRequest.packages, []);
  input.policy.environmentScope.maxPackages = 0;
  reject(() => assertEnvironmentAuthorization(auth, input), 'AUTOMATION_ENVIRONMENT_SCOPE_REVOKED');
  assert.deepEqual(createEnvironmentAuthorization(input).proposal.packages, []);
});

test('global and per-environment switches honor actual user policy, not execution-plan suggestions', () => {
  const input = context();
  for (const change of [{ enabled: false }, { overrides: { environment: 'manual' } }, { overrides: { environment: 'unknown' } }]) {
    reject(() => createEnvironmentAuthorization({ ...input, policy: { ...input.policy, ...change } }), 'AUTOMATION_ENVIRONMENT_DISABLED');
  }
  assert.equal(createEnvironmentAuthorization({ ...input, policy: { ...input.policy, enabled: false, overrides: { environment: 'auto' } } }).actor, 'system');
  input.session.executionPlan = { environmentScope: scope(), approved: true, capabilities: ['environment.prepare'] };
  delete input.policy.environmentScope;
  reject(() => createEnvironmentAuthorization(input), 'AUTOMATION_ENVIRONMENT_SCOPE_REQUIRED');
});

test('source/project/session/stage replacement and stopped sessions invalidate existing grants', () => {
  const input = context(), auth = createEnvironmentAuthorization(input);
  for (const next of [{ ...input, projectId: 'other' }, { ...input, sourceRunId: 'other' }, { ...input, stage: 'experiment' },
    { ...input, session: { ...input.session, id: 'other' } }, { ...input, session: { ...input.session, coordinatorRunId: 'other' } }]) {
    reject(() => assertEnvironmentAuthorization(auth, next), 'AUTOMATION_ENVIRONMENT_IDENTITY_CHANGED');
  }
  for (const change of [{ status: 'stopped' }, { stopRequested: true }]) {
    reject(() => assertEnvironmentAuthorization(auth, { ...input, session: { ...input.session, ...change } }), 'AUTOMATION_ENVIRONMENT_INACTIVE');
  }
  for (const next of [{ ...input, stage: 'writing' }, { ...input, sourceRunId: ' source-1' }, { ...input, session: { ...input.session, projectId: 'other' } },
    { ...input, session: { ...input.session, coordinatorRunId: '' } }, undefined]) {
    reject(() => createEnvironmentAuthorization(next), 'AUTOMATION_ENVIRONMENT_IDENTITY_INVALID');
  }
});

test('forged actor/capability/schema and undeclared authorization fields are rejected', () => {
  const input = context(), auth = createEnvironmentAuthorization(input);
  for (const change of [{ actor: 'model' }, { capability: 'experiment.execute' }, { schemaVersion: 2 }, { approve: true }]) {
    reject(() => assertEnvironmentAuthorization({ ...auth, ...change }, input), 'AUTOMATION_ENVIRONMENT_AUTHORIZATION_INVALID');
  }
});

test('changed fixed wheel path/SHA or tampered snapshot/hash cannot reuse an authorization', () => {
  const input = context(), auth = createEnvironmentAuthorization(input);
  for (const change of [{ scopeSha256: 'b'.repeat(64) }, { proposalSha256: 'b'.repeat(64) }, { scope: { ...auth.scope, maxPrepareMs: 4000 } },
    { proposal: { packages: [{ ...input.proposal.packages[0], sha256: 'b'.repeat(64) }] } }]) {
    reject(() => assertEnvironmentAuthorization({ ...auth, ...change }, input), 'AUTOMATION_ENVIRONMENT_BINDING_CHANGED');
  }
  for (const change of [{ path: 'dependencies/another-1.0-py3-none-any.whl' }, { sha256: 'b'.repeat(64) }]) {
    reject(() => assertEnvironmentAuthorization(auth, { ...input, proposal: { packages: [{ ...input.proposal.packages[0], ...change }] } }), 'AUTOMATION_ENVIRONMENT_BINDING_CHANGED');
  }
});

test('path-prefix boundaries and package quotas block ungranted files', () => {
  const input = context();
  for (const path of ['dependencies-other/example.whl', 'other/example.whl']) {
    reject(() => createEnvironmentAuthorization({ ...input, proposal: { packages: [{ path, sha256: 'a'.repeat(64) }] } }), 'AUTOMATION_ENVIRONMENT_PATH_DENIED');
  }
  input.policy.environmentScope.maxPackages = 0;
  reject(() => createEnvironmentAuthorization(input), 'AUTOMATION_ENVIRONMENT_PATH_DENIED');
});

test('current scope contraction revokes old paths or budgets even if the same proposal would fit', () => {
  const input = context(), auth = createEnvironmentAuthorization(input);
  for (const change of [{ maxPackages: 1 }, { maxPrepareMs: 4999 }, { maxOutputBytes: 8191 }, { maxEnvironments: 1 }]) {
    reject(() => assertEnvironmentAuthorization(auth, { ...input, policy: { ...input.policy, environmentScope: { ...scope(), ...change } } }), 'AUTOMATION_ENVIRONMENT_SCOPE_REVOKED');
  }
  const exactPath = { ...scope(), allowedPaths: [input.proposal.packages[0].path] };
  reject(() => assertEnvironmentAuthorization(auth, { ...input, policy: { ...input.policy, environmentScope: exactPath } }), 'AUTOMATION_ENVIRONMENT_SCOPE_REVOKED');
  reject(() => assertEnvironmentAuthorization(auth, { ...input, policy: { ...input.policy, overrides: { environment: 'manual' } } }), 'AUTOMATION_ENVIRONMENT_DISABLED');
});

test('later expanded policy preserves original budgets while invalid/rolled-back versions are blocked', () => {
  const input = context(), auth = createEnvironmentAuthorization(input), before = structuredClone(auth);
  const next = { ...input, policyVersion: 9, policy: { ...input.policy, environmentScope: { allowedPaths: ['dependencies', 'wheels'], maxPackages: 30,
    maxPrepareMs: 600000, maxOutputBytes: 2 * 1024 * 1024, maxEnvironments: 3 } } };
  const result = assertEnvironmentAuthorization(auth, next);
  assert.equal(result.currentPolicyVersion, 9); assert.equal(result.environmentRequest.timeoutMs, 5000); assert.equal(result.environmentRequest.maxOutputBytes, 8192);
  assert.deepEqual(auth, before);
  for (const policyVersion of [0, NaN, 1.5]) reject(() => createEnvironmentAuthorization({ ...input, policyVersion }), 'AUTOMATION_ENVIRONMENT_VERSION_INVALID');
  reject(() => assertEnvironmentAuthorization(auth, { ...input, policyVersion: 2 }), 'AUTOMATION_ENVIRONMENT_VERSION_INVALID');
  for (const key of ['actor', 'approved', 'verified', 'capabilities']) assert.equal(key in result.environmentRequest, false);
});
