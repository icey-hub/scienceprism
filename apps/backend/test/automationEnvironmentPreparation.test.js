import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-environment-preparation/', import.meta.url));
await fsp.mkdir(cache, { recursive: true });
const base = fs.realpathSync(await fsp.mkdtemp(path.join(cache, 'test-')));
process.env.SCIENCEPRISM_DATA_DIR = base; process.env.NODE_ENV = 'test';
after(() => fsp.rm(base, { recursive: true, force: true }));
const { createEnvironmentService } = await import('../src/services/experimentRunner/environments.js');
const { prepareAutomationEnvironment } = await import('../src/services/researchAutomation/environmentPreparation.js');
const hash = value => createHash('sha256').update(value).digest('hex');

async function fakePrepare(options) {
  await options.beforeLaunch(); options.signal.throwIfAborted(); await options.onLaunch();
  try {
    await fsp.mkdir(path.join(options.directory, 'bin'));
    await fsp.writeFile(path.join(options.directory, 'bin/python'), 'fixed-test-interpreter');
    return { python: { version: '3.fixture', implementation: 'fixture' }, packages: [], isolation: 'fixed-test-fixture' };
  } finally { await options.onProcess({ pid: null, stopConfirmed: true }); }
}

async function fixture(t, id, prepare) {
  const root = path.join(base, id); await fsp.mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await fsp.writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: ['experiment.execute'], allowedPaths: ['wheels'] }));
  const state = { version: 3, policy: { enabled: true, overrides: { environment: 'inherit' }, environmentScope: {
    allowedPaths: ['wheels'], maxPackages: 2, maxPrepareMs: 5000, maxOutputBytes: 8192, maxEnvironments: 2 } },
    session: { id: `session-${id}`, coordinatorRunId: `parent-${id}`, status: 'running', stopRequested: false, attempt: 0,
      steps: [{ stage: 'replication', calls: [{ runId: `source-${id}`, task: 'research:environment_proposal' }] }] } };
  const source = { id: `source-${id}`, projectId: id, status: 'completed', task: 'research:environment_proposal',
    parentRunId: state.session.coordinatorRunId, automationSessionId: state.session.id, stage: 'replication' };
  const automationFile = path.join(root, '.scienceprism/research-automation.json');
  const writeState = () => fsp.writeFile(automationFile, JSON.stringify(state)); await writeState();
  const readState = async () => JSON.parse(await fsp.readFile(automationFile, 'utf8'));
  const calls = [], saves = [];
  const newService = () => {
    const service = createEnvironmentService({ resolveProject: async projectId => { assert.equal(projectId, id); return root; },
      probe: async () => ({ available: true }), prepare: async options => {
        calls.push(options);
        const saved = (await readState()).session.steps[0].environmentPreparations[0];
        assert.equal(saved.authorization.actor, 'system'); assert.ok(saved.jobId, 'original job must be durably saved before preparation');
        return (prepare || fakePrepare)(options);
      } });
    t.after(() => service.shutdown()); return service;
  };
  const service = newService();
  const input = { projectId: id, session: structuredClone(state.session), stage: 'replication', sourceRunId: source.id,
    proposal: { packages: [] }, reason: 'Explicit fixture uses only standard library', service, readState,
    readRun: async () => structuredClone(source), beforeEffect: async () => {}, saveStep: async patch => {
      saves.push(structuredClone(patch)); Object.assign(state.session.steps[0], structuredClone(patch)); await writeState();
    } };
  return { root, state, source, input, service, newService, calls, saves, writeState, readState,
    index: path.join(base, '.scienceprism-environments', hash(id), 'index.json') };
}

test('completed source durably binds grant/job, creates verified content and cold service reuses one environment', async t => {
  const f = await fixture(t, 'normal'), result = await prepareAutomationEnvironment(f.input);
  const entry = (await f.readState()).session.steps[0].environmentPreparations[0], job = await f.service.get('normal', entry.jobId);
  assert.equal(entry.status, 'completed'); assert.equal(entry.authorization.sourceRunId, f.source.id);
  assert.equal(entry.authorization.parentRunId, f.state.session.coordinatorRunId); assert.equal(job.configuration.authority, 'system');
  assert.equal(entry.sha256, result.sha256); assert.equal(f.calls[0].timeoutMs, 5000); assert.equal(f.calls[0].maxOutputBytes, 8192);
  assert.equal(f.saves[0].environmentPreparations[0].jobId, null); assert.equal(job.process.stopConfirmed, true);
  const verified = await f.service.verify('normal', result.id, result.sha256);
  assert.equal(await fsp.readFile(verified.interpreter, 'utf8'), 'fixed-test-interpreter'); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const again = await prepareAutomationEnvironment({ ...f.input, service: f.newService() });
  assert.equal(again.id, result.id); assert.equal(again.sha256, result.sha256); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.listJobs('normal')).length, 1);
  await fsp.writeFile(verified.interpreter, 'changed-test-interpreter');
  await assert.rejects(prepareAutomationEnvironment({ ...f.input, service: f.newService() }), { code: 'ENVIRONMENT_CONTENT_CHANGED' });
  assert.equal(f.calls.length, 1);
});

test('onPrepared persistence failure leaves queued stable job; original chain next attempt resumes that exact job', async t => {
  const f = await fixture(t, 'callback-failure'), save = f.input.saveStep; let writes = 0;
  f.input.saveStep = async patch => { if (++writes === 2) throw new Error('fixed durable callback failure'); await save(patch); };
  await assert.rejects(prepareAutomationEnvironment(f.input), /fixed durable callback failure/);
  const queued = (await f.service.listJobs('callback-failure'))[0]; assert.equal(queued.status, 'interrupted');
  assert.equal(JSON.parse(await fsp.readFile(f.index, 'utf8')).jobs[0].status, 'queued'); assert.equal(f.calls.length, 0);
  assert.equal(f.state.session.steps[0].environmentPreparations[0].jobId, queued.id);
  f.state.session.attempt++; await f.writeState();
  const recovered = await prepareAutomationEnvironment({ ...f.input, service: f.newService() });
  assert.equal(recovered.id, queued.id); assert.equal(f.calls.length, 1); assert.equal((await f.service.listJobs('callback-failure')).length, 1);
});

test('manual or reduced current scope at actual beforeLaunch prevents publication with stopped receipt', async t => {
  for (const kind of ['manual', 'scope']) {
    let f, launches = 0;
    f = await fixture(t, `revoke-${kind}`, async options => {
      if (kind === 'manual') f.state.policy.overrides.environment = 'manual'; else f.state.policy.environmentScope.maxPrepareMs--;
      f.state.version++; await f.writeState(); await options.beforeLaunch(); launches++; return fakePrepare(options);
    });
    await assert.rejects(prepareAutomationEnvironment(f.input), { code: kind === 'manual' ? 'AUTOMATION_ENVIRONMENT_DISABLED' : 'AUTOMATION_ENVIRONMENT_SCOPE_REVOKED' });
    const job = (await f.service.listJobs(`revoke-${kind}`))[0];
    assert.equal(job.status, 'failed'); assert.equal(job.process.stopConfirmed, true); assert.equal(job.environment, undefined); assert.equal(launches, 0);
    assert.equal(f.state.session.steps[0].environmentPreparations[0].status, 'failed');
  }
});

test('parent abort settles stopped preparation, forbids public retry and resumes original job in next chain attempt', async t => {
  let entered, attempts = 0, settled = false;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, 'cancel', async options => {
    if (++attempts > 1) return fakePrepare(options);
    await options.beforeLaunch(); await options.onLaunch(); entered();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 20)); await options.onProcess({ pid: null, stopConfirmed: true }); settled = true;
    throw Object.assign(new Error('fixed cancelled preparation'), { code: 'PYTHON_ENVIRONMENT_CANCELLED' });
  });
  const controller = new AbortController(), pending = prepareAutomationEnvironment({ ...f.input, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'PYTHON_ENVIRONMENT_CANCELLED' }); await started; controller.abort(new Error('parent stopped')); await rejected;
  const entry = f.state.session.steps[0].environmentPreparations[0], jobId = entry.jobId, cancelled = await f.service.get('cancel', jobId);
  assert.equal(settled, true); assert.equal(entry.status, 'cancelled'); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.process.stopConfirmed, true);
  await assert.rejects(f.service.retry('cancel', jobId), { code: 'ENVIRONMENT_AUTOMATION_OWNED' });
  await assert.rejects(prepareAutomationEnvironment(f.input), { code: 'AUTOMATION_ENVIRONMENT_FAILED' }); assert.equal(attempts, 1);
  f.state.session.attempt++; await f.writeState();
  const recovered = await prepareAutomationEnvironment({ ...f.input, service: f.newService() });
  assert.equal(recovered.id, jobId); assert.equal((await f.service.get('cancel', jobId)).attempt, 2);
  assert.equal(attempts, 2); assert.equal((await f.service.listJobs('cancel')).length, 1);
});

test('foreign, incomplete or unrecorded producer cannot persist a grant or prepare a job', async t => {
  const f = await fixture(t, 'producer'), original = structuredClone(f.source);
  for (const change of [{ id: 'other' }, { status: 'running' }, { projectId: 'other' }, { parentRunId: 'other' },
    { automationSessionId: 'other' }, { stage: 'experiment' }, { task: 'research:execution_proposal' }]) {
    Object.assign(f.source, original, change);
    await assert.rejects(prepareAutomationEnvironment(f.input), { code: 'AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED' });
  }
  Object.assign(f.source, original); f.state.session.steps[0].calls = []; await f.writeState();
  await assert.rejects(prepareAutomationEnvironment(f.input), { code: 'AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED' });
  assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0); assert.equal((await f.service.listJobs('producer')).length, 0);
});

test('replaced authoritative session cannot adopt an old caller producer even if its call ID was copied', async t => {
  const f = await fixture(t, 'session-replaced'); f.state.session.id = 'replacement-session'; await f.writeState();
  await assert.rejects(prepareAutomationEnvironment(f.input), { code: 'AUTOMATION_ENVIRONMENT_PRODUCER_CHANGED' });
  assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0); assert.equal((await f.service.listJobs('session-replaced')).length, 0);
});

test('environment count budget applies across chain stages before any new side effect', async t => {
  const f = await fixture(t, 'count'); f.state.policy.environmentScope.maxEnvironments = 1;
  f.state.session.steps.push({ stage: 'experiment', environmentPreparations: [{ authorization: { sourceRunId: 'prior' } }] }); await f.writeState();
  await assert.rejects(prepareAutomationEnvironment(f.input), { code: 'AUTOMATION_ENVIRONMENT_LIMIT' });
  assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0); assert.equal((await f.service.listJobs('count')).length, 0);
});

test('changed stored job reference never creates or repeats an effect under the original grant', async t => {
  const f = await fixture(t, 'job-changed'), original = await prepareAutomationEnvironment(f.input);
  f.state.session.steps[0].environmentPreparations[0].jobId = 'environment-00000000-0000-4000-8000-000000000000'; await f.writeState();
  await assert.rejects(prepareAutomationEnvironment({ ...f.input, service: f.newService() }), { code: 'ENVIRONMENT_NOT_FOUND' });
  assert.equal(f.calls.length, 1); const jobs = await f.service.listJobs('job-changed');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].id, original.id); assert.equal(jobs[0].status, 'ready');
});

async function humanEnvironment(t, f, configuration = {}) {
  const service = createEnvironmentService({ resolveProject: async () => f.root, prepare: fakePrepare, probe: async () => ({ available: true }) });
  t.after(() => service.shutdown()); const created = await service.create(f.input.projectId, configuration);
  for (let i = 0; i < 100; i++) {
    const job = await service.get(f.input.projectId, created.id);
    if (job.status === 'ready') return { service, job, verified: await service.verify(f.input.projectId, job.id) };
    assert.notEqual(job.status, 'failed'); await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('fixed human environment did not settle');
}
function restoreInterpreter(t) {
  const before = process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
  t.after(() => { if (before === undefined) delete process.env.SCIENCEPRISM_EXPERIMENT_PYTHON; else process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = before; });
}

test('completed-result save failure recovers original system job even when a new human cache is available', async t => {
  const f = await fixture(t, 'completed-save'), save = f.input.saveStep; let writes = 0; restoreInterpreter(t);
  f.input.saveStep = async patch => { if (++writes === 3) throw new Error('fixed completed-result save failure'); await save(patch); };
  await assert.rejects(prepareAutomationEnvironment(f.input), /fixed completed-result save failure/);
  const systemId = f.state.session.steps[0].environmentPreparations[0].jobId;
  assert.equal((await f.service.get('completed-save', systemId)).status, 'ready'); assert.equal(f.calls.length, 1);
  const human = await humanEnvironment(t, f); process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = human.verified.interpreter;
  f.state.session.attempt++; await f.writeState();
  const recovered = await prepareAutomationEnvironment({ ...f.input, service: f.newService() });
  assert.equal(recovered.id, systemId); assert.notEqual(recovered.id, human.job.id); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.listJobs('completed-save')).length, 2);
});

test('first compatible human cache selection stays fixed after another compatible cache appears', async t => {
  const f = await fixture(t, 'human-fixed'); restoreInterpreter(t);
  const first = await humanEnvironment(t, f); process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = first.verified.interpreter;
  const selected = await prepareAutomationEnvironment(f.input);
  assert.equal(selected.id, first.job.id); assert.equal(f.calls.length, 0);
  const second = await humanEnvironment(t, f, { timeoutMs: 1000, maxOutputBytes: 1024 });
  assert.notEqual(second.job.id, first.job.id); process.env.SCIENCEPRISM_EXPERIMENT_PYTHON = second.verified.interpreter;
  const again = await prepareAutomationEnvironment({ ...f.input, service: f.newService() });
  assert.equal(again.id, first.job.id); assert.equal(f.calls.length, 0); assert.equal((await f.service.listJobs('human-fixed')).length, 2);
});
