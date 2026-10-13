import test, { after } from 'node:test';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-dataset-acquisition/', import.meta.url));
await fsp.mkdir(cache, { recursive: true });
const dataDir = fs.realpathSync(await fsp.mkdtemp(path.join(cache, 'test-')));
process.env.SCIENCEPRISM_DATA_DIR = dataDir; process.env.NODE_ENV = 'test';
after(() => fsp.rm(dataDir, { recursive: true, force: true }));
const { createDatasetService } = await import('../src/services/datasets/index.js');
const { createDatasetRepository } = await import('../src/services/datasets/repository.js');
const { acquireAutomationDataset } = await import('../src/services/researchAutomation/datasetAcquisition.js');
const { createDatasetAuthorization, assertDatasetAuthorization } = await import('../src/services/researchAutomation/datasetAuthorization.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceUrl = 'https://raw.githubusercontent.com/owner/repo/revision/data.csv';
const bytes = Buffer.from('x,y\n1,2\n');

async function fixture(t, id, download) {
  const root = path.join(dataDir, id); await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  const state = { version: 1, policy: { enabled: true, overrides: { dataset: 'inherit' },
    datasetScope: { allowedHosts: ['raw.githubusercontent.com'], maxBytes: 1024, maxDatasets: 2 } },
    session: { id: `session-${id}`, coordinatorRunId: `parent-${id}`, status: 'running', stopRequested: false, attempt: 0,
      steps: [{ stage: 'replication', calls: [{ runId: `source-${id}`, task: 'research:dataset_discovery' }] }] } };
  const producer = { id: `source-${id}`, projectId: id, parentRunId: state.session.coordinatorRunId,
    automationSessionId: state.session.id, stage: 'replication', status: 'completed', task: 'research:dataset_discovery' };
  const calls = [], saves = [], repository = createDatasetRepository();
  const fixedDownload = async (url, options) => {
    await options.beforeRequest?.(); options.signal.throwIfAborted(); calls.push(url);
    assert.ok(state.session.steps[0].datasetAcquisitions?.[0]?.authorization, 'grant must be durably saved before transfer');
    await fsp.writeFile(options.destination, bytes, { mode: 0o600 });
    await options.onProgress({ receivedBytes: bytes.length, totalBytes: bytes.length });
    return { sha256: hash(bytes), byteLength: bytes.length, resolvedUrl: url };
  };
  const newService = () => { const service = createDatasetService({ repository, download: download || fixedDownload }); t.after(() => service.shutdown()); return service; };
  const service = newService();
  const input = { projectId: id, session: state.session, stage: 'replication', sourceRunId: producer.id,
    proposal: { paperId: 'paper-1', url: sourceUrl, filename: 'data.csv', license: 'CC0', expectedSha256: hash(bytes) },
    evidenceQuote: 'Paper dataset source', service, readState: async () => structuredClone(state), readRun: async () => structuredClone(producer),
    beforeEffect: async () => {}, saveStep: async patch => { saves.push(structuredClone(patch)); Object.assign(state.session.steps[0], structuredClone(patch)); } };
  return { root, state, producer, calls, saves, service, newService, input };
}

test('saved system grant and completed source produce real immutable hash content; completed retry is cached', async t => {
  const f = await fixture(t, 'normal'), result = await acquireAutomationDataset(f.input), entry = f.state.session.steps[0].datasetAcquisitions[0];
  assert.equal(entry.status, 'completed'); assert.equal(entry.authorization.actor, 'system'); assert.equal(entry.authorization.sourceRunId, f.producer.id);
  assert.equal(entry.authorization.parentRunId, f.state.session.coordinatorRunId); assert.equal(result.sha256, hash(bytes));
  assert.deepEqual((await f.service.content('normal', result.id)).bytes, bytes);
  const job = await f.service.getJob('normal', entry.jobId);
  assert.equal(job.configuration.authority, 'system'); assert.equal(job.configuration.maxBytes, 1024);
  assert.equal(result.license.verified, false); assert.equal(f.saves[0].datasetAcquisitions[0].jobId, null);
  const again = await acquireAutomationDataset({ ...f.input, service: f.newService() });
  assert.equal(again.id, result.id); assert.equal(f.state.session.steps[0].datasetAcquisitions[0].jobId, job.id);
  assert.equal(f.calls.length, 1); assert.equal((await f.service.list('normal')).jobs.length, 1);
});

test('prepared callback failure preserves one queued job; new service recovers the same frozen identity', async t => {
  const f = await fixture(t, 'prepared-failure');
  const auth = createDatasetAuthorization({ ...f.input, policyVersion: f.state.version, policy: f.state.policy });
  f.state.session.steps[0].datasetAcquisitions = [{ authorization: auth }];
  const guard = async () => assertDatasetAuthorization(auth, { ...f.input, session: f.state.session, policyVersion: f.state.version, policy: f.state.policy });
  const { datasetRequest } = await guard(); let jobId;
  await assert.rejects(f.service.acquireAuthorized('prepared-failure', datasetRequest, { authorization: auth, assertAuthorized: guard,
    onPrepared: async job => { jobId = job.id; throw new Error('fixed durable callback failure'); } }), /fixed durable callback failure/);
  assert.equal(f.calls.length, 0); assert.equal((await f.service.list('prepared-failure')).jobs.length, 1);
  const recovered = await f.newService().acquireAuthorized('prepared-failure', datasetRequest, { authorization: auth, assertAuthorized: guard,
    onPrepared: async job => assert.equal(job.id, jobId) });
  assert.equal(recovered.job.id, jobId); assert.equal(recovered.dataset.sha256, hash(bytes)); assert.equal(f.calls.length, 1);
});

test('global/manual revocation after saving the grant blocks all real acquisition effects', async t => {
  for (const mode of ['global', 'manual']) {
    const id = `revoke-${mode}`, f = await fixture(t, id), save = f.input.saveStep;
    f.input.saveStep = async patch => { await save(patch); if (mode === 'global') f.state.policy.enabled = false; else f.state.policy.overrides.dataset = 'manual'; f.state.version++; };
    await assert.rejects(acquireAutomationDataset(f.input), { code: 'AUTOMATION_DATASET_DISABLED' });
    assert.equal(f.calls.length, 0); assert.equal((await f.service.list(id)).jobs.length, 0);
    assert.equal(f.state.session.steps[0].datasetAcquisitions[0].authorization.actor, 'system');
  }
});

test('missing explicit scope or plan-supplied scope cannot create or download a dataset', async t => {
  const f = await fixture(t, 'missing-scope'); delete f.state.policy.datasetScope;
  f.state.session.executionPlan = { datasetScope: { allowedHosts: ['raw.githubusercontent.com'], maxBytes: 1024, maxDatasets: 2 }, approved: true };
  await assert.rejects(acquireAutomationDataset(f.input), { code: 'AUTOMATION_DATASET_SCOPE_REQUIRED' });
  assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0); assert.equal((await f.service.list('missing-scope')).jobs.length, 0);
});

test('host and both budget revocations between persistence and dispatch block the actual downloader', async t => {
  for (const [kind, change, code] of [['host', { allowedHosts: ['zenodo.org'] }, 'AUTOMATION_DATASET_HOST_DENIED'],
    ['bytes', { maxBytes: 1023 }, 'AUTOMATION_DATASET_SCOPE_REVOKED'], ['count', { maxDatasets: 1 }, 'AUTOMATION_DATASET_SCOPE_REVOKED']]) {
    const id = `scope-${kind}`, f = await fixture(t, id), save = f.input.saveStep;
    f.input.saveStep = async patch => { await save(patch); Object.assign(f.state.policy.datasetScope, change); f.state.version++; };
    await assert.rejects(acquireAutomationDataset(f.input), { code });
    assert.equal(f.calls.length, 0); assert.equal((await f.service.list(id)).datasets.length, 0); assert.equal((await f.service.list(id)).jobs.length, 0);
  }
});

test('uncompleted, foreign or unrecorded source runs cannot produce a system job', async t => {
  const f = await fixture(t, 'source-guard'), original = structuredClone(f.producer);
  for (const change of [{ status: 'running' }, { projectId: 'foreign' }, { parentRunId: 'foreign' }, { automationSessionId: 'foreign' },
    { stage: 'experiment' }, { task: 'research:execution_proposal' }, { id: 'foreign' }]) {
    Object.assign(f.producer, original, change);
    await assert.rejects(acquireAutomationDataset(f.input), { code: 'AUTOMATION_DATASET_PRODUCER_CHANGED' });
  }
  Object.assign(f.producer, original); f.state.session.steps[0].calls = [];
  await assert.rejects(acquireAutomationDataset(f.input), { code: 'AUTOMATION_DATASET_PRODUCER_CHANGED' });
  assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0); assert.equal((await f.service.list('source-guard')).jobs.length, 0);
});

test('saved-grant persistence failure prevents all download and job effects', async t => {
  const f = await fixture(t, 'save-failed'); f.input.saveStep = async () => { throw new Error('fixed persistence unavailable'); };
  await assert.rejects(acquireAutomationDataset(f.input), /fixed persistence unavailable/);
  assert.equal(f.calls.length, 0); assert.equal((await f.service.list('save-failed')).jobs.length, 0);
});

test('parent cancellation waits for actual transfer settlement; human resume cannot bypass system ownership', async t => {
  let ready, attempts = 0, settled = false;
  const entered = new Promise(resolve => { ready = resolve; });
  const f = await fixture(t, 'cancel', async (url, options) => {
    attempts++; await options.beforeRequest();
    if (attempts === 1) {
      await fsp.writeFile(options.destination, bytes.subarray(0, 4), { mode: 0o600 });
      await options.onProgress({ receivedBytes: 4, totalBytes: bytes.length, etag: '"stable"', resolvedUrl: url }); ready();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      await new Promise(resolve => setTimeout(resolve, 20)); settled = true; options.signal.throwIfAborted();
    }
    assert.equal(options.resume.receivedBytes, 4); assert.equal(options.resume.etag, '"stable"');
    assert.deepEqual(await fsp.readFile(options.destination), bytes.subarray(0, 4));
    await fsp.appendFile(options.destination, bytes.subarray(4));
    await options.onProgress({ receivedBytes: bytes.length, totalBytes: bytes.length });
    return { sha256: hash(bytes), byteLength: bytes.length, resolvedUrl: url };
  });
  const controller = new AbortController(), pending = acquireAutomationDataset({ ...f.input, signal: controller.signal });
  const outcome = assert.rejects(pending, { code: 'DATASET_CANCELLED' }); await entered; controller.abort(new Error('parent stopped')); await outcome;
  assert.equal(settled, true); const entry = f.state.session.steps[0].datasetAcquisitions[0], jobId = entry.jobId;
  assert.equal(entry.status, 'cancelled'); assert.equal((await f.service.list('cancel')).datasets.length, 0);
  await assert.rejects(f.service.resume('cancel', jobId, { expectedConfigurationVersion: 1 }), { code: 'DATASET_AUTOMATION_OWNED' });
  await assert.rejects(acquireAutomationDataset(f.input), { code: 'AUTOMATION_DATASET_FAILED' }); assert.equal(attempts, 1);
  f.state.session.attempt++; const dataset = await acquireAutomationDataset({ ...f.input, service: f.newService() });
  assert.equal(f.state.session.steps[0].datasetAcquisitions[0].jobId, jobId); assert.equal(attempts, 2);
  assert.deepEqual((await f.service.content('cancel', dataset.id)).bytes, bytes); assert.equal((await f.service.list('cancel')).jobs.length, 1);
});

test('session-wide count budget counts prior acquisitions before any new effect', async t => {
  const f = await fixture(t, 'count-limit'); f.state.policy.datasetScope.maxDatasets = 1;
  f.state.session.steps.push({ stage: 'experiment', datasetAcquisitions: [{ authorization: { sourceRunId: 'other' } }] });
  await assert.rejects(acquireAutomationDataset(f.input), { code: 'AUTOMATION_DATASET_LIMIT' });
  assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0); assert.equal((await f.service.list('count-limit')).jobs.length, 0);
});
