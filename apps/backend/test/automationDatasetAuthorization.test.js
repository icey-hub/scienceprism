import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDatasetScope, validateDatasetProposal, createDatasetAuthorization, assertDatasetAuthorization } from '../src/services/researchAutomation/datasetAuthorization.js';
import { MAX_DATASET_BYTES } from '../src/services/datasets/download.js';
import { ResearchWorkflowError } from '../src/services/researchWorkflow/errors.js';

const scope = () => ({ allowedHosts: ['raw.githubusercontent.com'], maxBytes: 1024, maxDatasets: 2 });
const context = () => ({ projectId: 'project-1', session: { id: 'session-1', coordinatorRunId: 'run-parent', status: 'running', stopRequested: false },
  stage: 'replication', policyVersion: 3, policy: { enabled: true, overrides: { dataset: 'inherit' }, datasetScope: scope() },
  proposal: { paperId: 'paper-1', url: 'https://raw.githubusercontent.com/owner/repo/revision/data.csv', filename: 'data.csv', license: 'CC0', split: 'train', expectedSha256: 'a'.repeat(64) },
  sourceRunId: 'run-source' });
const reject = (fn, code) => assert.throws(fn, error => error instanceof ResearchWorkflowError && error.code === code);

test('scope is explicit, strict, normalized and bounded; old missing scope grants nothing', () => {
  assert.equal(validateDatasetScope(), null); assert.equal(validateDatasetScope(null), null);
  assert.deepEqual(validateDatasetScope({ ...scope(), allowedHosts: ['zenodo.org', 'raw.githubusercontent.com', 'zenodo.org'] }),
    { ...scope(), allowedHosts: ['raw.githubusercontent.com', 'zenodo.org'] });
  for (const change of [{ allowedHosts: [] }, { allowedHosts: ['*.githubusercontent.com'] }, { allowedHosts: ['example.org'] },
    { allowedHosts: Array(1) },
    { maxBytes: MAX_DATASET_BYTES + 1 }, { maxBytes: 0 }, { maxBytes: Infinity }, { maxDatasets: 6 }, { maxDatasets: 0 }, { maxDatasets: 1.5 }, { actor: 'model' }]) {
    reject(() => validateDatasetScope({ ...scope(), ...change }), 'AUTOMATION_DATASET_SCOPE_INVALID');
  }
});

test('proposal uses real downloader and filename boundaries without accepting authority fields', () => {
  const original = context().proposal;
  assert.deepEqual(validateDatasetProposal(original), original);
  assert.equal(validateDatasetProposal({ paperId: 'paper-1', url: original.url, filename: 'data.csv' }).split, 'unknown');
  for (const change of [{ paperId: '' }, { url: 'https://example.org/data.csv' }, { url: `${original.url}?token=private` },
    { url: 'https://huggingface.co/datasets/u/repo/resolve/main/data.csv' }, { filename: '../data.csv' }, { filename: 'code.py' },
    { license: 'x'.repeat(301) }, { split: 'execute' }, { expectedSha256: 'A'.repeat(64) }, { maxBytes: 100 }, { actor: 'system' }, { approve: true }]) {
    reject(() => validateDatasetProposal({ ...original, ...change }), 'AUTOMATION_DATASET_PROPOSAL_INVALID');
  }
  const pinned = `https://huggingface.co/datasets/u/repo/resolve/${'a'.repeat(40)}/data.csv`;
  assert.equal(validateDatasetProposal({ ...original, url: pinned }).url, pinned);
});

test('authorization snapshot and request bind source and original ceiling with no input mutation', () => {
  const input = context(), before = structuredClone(input), auth = createDatasetAuthorization(input);
  assert.deepEqual(input, before);
  assert.equal(auth.schemaVersion, 1); assert.equal(auth.actor, 'system'); assert.equal(auth.capability, 'dataset.acquire');
  assert.equal(auth.parentRunId, input.session.coordinatorRunId); assert.equal(auth.policyVersion, 3);
  const { datasetRequest, currentPolicyVersion } = assertDatasetAuthorization(auth, input);
  const { paperId, ...expected } = input.proposal;
  assert.deepEqual(datasetRequest, { ...expected, maxBytes: 1024, refresh: false });
  assert.equal(currentPolicyVersion, 3);
});

test('global and individual dataset switches apply; execution plans cannot self-authorize', () => {
  for (const policy of [{ enabled: false, overrides: { dataset: 'inherit' }, datasetScope: scope() },
    { enabled: true, overrides: { dataset: 'manual' }, datasetScope: scope() }]) {
    reject(() => createDatasetAuthorization({ ...context(), policy }), 'AUTOMATION_DATASET_DISABLED');
  }
  const input = context(); input.policy.datasetScope = null;
  input.session.executionPlan = { datasetScope: scope(), capabilities: ['dataset.acquire'], approved: true };
  reject(() => createDatasetAuthorization(input), 'AUTOMATION_DATASET_SCOPE_REQUIRED');
  input.policy = { enabled: false, overrides: { dataset: 'auto' }, datasetScope: scope() };
  assert.equal(createDatasetAuthorization(input).actor, 'system');
});

test('stopped or replaced session and all source identity changes fail closed', () => {
  const input = context(), auth = createDatasetAuthorization(input);
  for (const next of [{ ...input, projectId: 'other' }, { ...input, sourceRunId: 'other' }, { ...input, stage: 'experiment' },
    { ...input, session: { ...input.session, id: 'other' } }, { ...input, session: { ...input.session, coordinatorRunId: 'other' } }]) {
    reject(() => assertDatasetAuthorization(auth, next), 'AUTOMATION_DATASET_IDENTITY_CHANGED');
  }
  for (const change of [{ status: 'stopped' }, { stopRequested: true }]) {
    reject(() => assertDatasetAuthorization(auth, { ...input, session: { ...input.session, ...change } }), 'AUTOMATION_DATASET_INACTIVE');
  }
  reject(() => createDatasetAuthorization({ ...input, stage: 'writing' }), 'AUTOMATION_DATASET_IDENTITY_INVALID');
  reject(() => createDatasetAuthorization({ ...input, session: { ...input.session, coordinatorRunId: '' } }), 'AUTOMATION_DATASET_IDENTITY_INVALID');
  reject(() => createDatasetAuthorization({ ...input, sourceRunId: ' run-source' }), 'AUTOMATION_DATASET_IDENTITY_INVALID');
  reject(() => createDatasetAuthorization(), 'AUTOMATION_DATASET_IDENTITY_INVALID');
});

test('forged actor/capability/schema and undeclared snapshot fields are rejected', () => {
  const input = context(), auth = createDatasetAuthorization(input);
  for (const change of [{ actor: 'model' }, { capability: 'experiment.execute' }, { schemaVersion: 2 }, { approve: true }]) {
    reject(() => assertDatasetAuthorization({ ...auth, ...change }, input), 'AUTOMATION_DATASET_AUTHORIZATION_INVALID');
  }
});

test('original snapshot hashes and changed proposal fields cannot be silently reused', () => {
  const input = context(), auth = createDatasetAuthorization(input);
  for (const change of [{ proposalSha256: 'b'.repeat(64) }, { scopeSha256: 'b'.repeat(64) },
    { scope: { ...auth.scope, maxBytes: 1023 } }, { proposal: { ...auth.proposal, license: 'other' } }]) {
    reject(() => assertDatasetAuthorization({ ...auth, ...change }, input), 'AUTOMATION_DATASET_BINDING_CHANGED');
  }
  for (const change of [{ paperId: 'other' }, { filename: 'other.csv' }, { url: `${input.proposal.url}?download=1` },
    { license: 'other' }, { split: 'test' }, { expectedSha256: 'b'.repeat(64) }]) {
    reject(() => assertDatasetAuthorization(auth, { ...input, proposal: { ...input.proposal, ...change } }), 'AUTOMATION_DATASET_BINDING_CHANGED');
  }
});

test('current policy changes revoke auto mode, host or either budget even with original version', () => {
  const input = context(), auth = createDatasetAuthorization(input);
  reject(() => assertDatasetAuthorization(auth, { ...input, policy: { ...input.policy, overrides: { dataset: 'manual' } } }), 'AUTOMATION_DATASET_DISABLED');
  reject(() => assertDatasetAuthorization(auth, { ...input, policy: { ...input.policy, datasetScope: { ...scope(), allowedHosts: ['zenodo.org'] } } }), 'AUTOMATION_DATASET_HOST_DENIED');
  for (const change of [{ maxBytes: 1023 }, { maxDatasets: 1 }]) {
    reject(() => assertDatasetAuthorization(auth, { ...input, policy: { ...input.policy, datasetScope: { ...scope(), ...change } } }), 'AUTOMATION_DATASET_SCOPE_REVOKED');
  }
});

test('new policy version and larger scope keep original budget and immutable source', () => {
  const input = context(), auth = createDatasetAuthorization(input), before = structuredClone(auth);
  const next = { ...input, policyVersion: 9, policy: { ...input.policy, datasetScope: { allowedHosts: ['zenodo.org', 'raw.githubusercontent.com'], maxBytes: MAX_DATASET_BYTES, maxDatasets: 5 } } };
  const result = assertDatasetAuthorization(auth, next);
  assert.equal(result.currentPolicyVersion, 9); assert.equal(result.datasetRequest.maxBytes, 1024);
  assert.equal(result.datasetRequest.url, input.proposal.url); assert.deepEqual(auth, before);
  reject(() => createDatasetAuthorization({ ...input, policyVersion: NaN }), 'AUTOMATION_DATASET_VERSION_INVALID');
});

test('acquisition authorization remains independent of scientific confirmation and experiment execution', () => {
  const input = context(); input.session.scientificallyConfirmed = false;
  input.session.executionPlan = { approved: false }; input.session.steps = [{ stage: 'replication', evidenceConfirmed: false }];
  const result = assertDatasetAuthorization(createDatasetAuthorization(input), input);
  assert.equal(result.datasetRequest.refresh, false);
  for (const key of ['approved', 'verified', 'evidenceConfirmed', 'capabilities', 'actor', 'paperId']) assert.equal(key in result.datasetRequest, false);
  assert.equal(input.session.scientificallyConfirmed, false); assert.equal(input.session.executionPlan.approved, false);
});
