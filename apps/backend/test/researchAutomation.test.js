import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fileIO } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';

process.env.SCIENCEPRISM_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'automation-'));
process.env.NODE_ENV = 'test';
const { readAutomation, saveAutomationPolicy, allowsAutomatic, automaticWorkflowDecision, mutateAutomation } = await import('../src/services/researchAutomation/policy.js');
const { startAutomation, getAutomation, resumeAutomation, stopAutomation, automaticallyApplyPatches } = await import('../src/services/researchAutomation/index.js');
const { getResearchWorkflow } = await import('../src/services/researchWorkflow/queries.js');
const { approveResearchWorkflow } = await import('../src/services/researchWorkflow/commands.js');
const { getEvidenceLedger } = await import('../src/services/evidenceLedger/index.js');
const { getExperimentRun } = await import('../src/services/experimentRunner/index.js');
const { listHarnessRuns, runHarnessRequest, decideHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { registerResearchSourceAdapter } = await import('../src/services/researchSources/index.js');
const { registerResearchWorkflowRoutes } = await import('../src/routes/researchWorkflow.js');
let sourceWait;
let sourceCalls = 0;
registerResearchSourceAdapter({ id: 'arxiv', label: 'Controlled source', async search({ beforeRequest }) {
  await beforeRequest?.({ source: 'arxiv', url: 'https://export.arxiv.org/api/query' });
  sourceCalls++; if (sourceWait) await sourceWait;
  return [{ id: 'p1', title: 'Controlled paper', abstract: 'Testing actual pipeline plumbing.', authors: ['Fixture Author'], year: 2025, url: 'https://arxiv.org/abs/2601.00001', venue: 'Test Conference', publicationType: 'conference', peerReviewed: true, source: 'arxiv' }];
} });
// Invalid strategy output falls back to all registered sources. Keep that
// failure path deterministic instead of contacting the real OpenAlex service.
registerResearchSourceAdapter({ id: 'openalex', label: 'Controlled unavailable source', async search({ beforeRequest }) {
  await beforeRequest?.({ source: 'openalex', url: 'https://api.openalex.org/works' });
  throw Object.assign(new Error('Controlled OpenAlex fixture unavailable.'), { code: 'SOURCE_UNAVAILABLE', retryable: false });
} });

test('a stale running snapshot cannot relabel a durably completed research chain as interrupted', async t => {
  await project('terminal-query');
  await mutateAutomation('terminal-query', state => { state.session = { id: 'query-fixture', status: 'completed', steps: [], message: 'done' }; });
  const read = fileIO.readFile.bind(fileIO); let delayedSnapshot = false;
  t.mock.method(fileIO, 'readFile', async (file, ...args) => {
    const content = await read(file, ...args);
    if (String(file).endsWith('research-automation.json') && !delayedSnapshot) {
      delayedSnapshot = true;
      const stale = JSON.parse(content); stale.session.status = 'running';
      return JSON.stringify(stale);
    }
    return content;
  });
  const actual = await getAutomation('terminal-query');
  assert.equal(delayedSnapshot, true); assert.equal(actual.session.status, 'completed'); assert.equal(actual.session.message, 'done');
});
const runtime = { adapter: 'fake', testInput: {
  search: { fakeResponse: JSON.stringify({ stage: 'search_strategy', researchQuestion: 'Question', humanDirection: 'Question', queries: ['Question'], sources: ['arxiv'], rationale: 'Controlled strategy' }) },
  paper_selection: { fakeResponse: JSON.stringify({ stage: 'paper_selection', paperIds: ['p1'], rationale: 'Relevant controlled source' }) },
  reproduction_plan: { fakeResponse: JSON.stringify({ stage: 'reproduction_plan', paperId: 'p1', objective: 'Read the supplied data and calculate its mean.', metrics: ['mean'], expectedOutputs: ['results/metrics.json'], humanApprovalRequired: true }) },
  ideation: { fakeResponse: JSON.stringify({ stage: 'innovation_ideas', humanDirection: 'Interpret actual mean and limitations.', ideas: [{ id: 'idea1', title: 'Hypothesis', problem: 'Small sample', motivation: 'Limited external validity', hypothesis: 'A larger sample may differ', novelty: 'Test robustness', relatedPaperIds: ['p1'], validationPlan: ['Use a new held-out sample'], risks: ['Not yet verified'] }], caveats: ['The fixture does not establish a scientific finding.'] }) }
} };

async function project(id, execute = true) {
  const root = path.join(process.env.SCIENCEPRISM_DATA_DIR, id);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id }));
  await writeFile(path.join(root, '.scienceprism/project-constraints.json'), JSON.stringify({ capabilities: execute ? ['project.read', 'experiment.execute'] : ['project.read'], maxConcurrent: 1 }));
  await writeFile(path.join(root, 'data.json'), '[2,4,6]');
  await writeFile(path.join(root, 'run.mjs'), `import { readFile, mkdir, writeFile } from 'node:fs/promises';
const values=JSON.parse(await readFile('data.json','utf8'));
await mkdir('results',{recursive:true});
await writeFile('results/metrics.json',JSON.stringify({metrics:[{name:'mean',value:values.reduce((a,b)=>a+b,0)/values.length}]}));`);
  return root;
}
const plan = { dataset: 'data.json', datasetVersion: 'fixture-v1', protocol: 'Compute a mean from the saved fixture.', execution: { adapter: 'node', entrypoint: 'run.mjs', args: [] }, seed: 0, successCriteria: ['Record mean'], artifacts: [{ path: 'results/metrics.json', kind: 'metric' }] };
async function enable(id, overrides = {}) { const state = await readAutomation(id); return saveAutomationPolicy(id, { actor: 'human', expectedVersion: state.version, policy: { enabled: true, overrides, agentMode: 'specialists' } }); }
async function settled(id) {
  for (let i = 0; i < 250; i++) { const state = await getAutomation(id); if (!['queued', 'running', 'stopping'].includes(state.session?.status)) return state; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('automation did not settle');
}

function interruptSearchSave(t) {
  const rename = fileIO.rename.bind(fileIO); let interrupted = false;
  t.mock.method(fileIO, 'rename', async (from, to) => {
    if (!interrupted && String(to).endsWith('research-workflow.json')) {
      const document = JSON.parse(await readFile(from, 'utf8'));
      if (document.stages.find(stage => stage.id === 'search').data.task) {
        interrupted = true; throw Object.assign(new Error('Fixture interrupted workflow save'), { code: 'EIO' });
      }
    }
    return rename(from, to);
  });
  return () => interrupted;
}

async function waitForSource(previous) {
  for (let i = 0; i < 200 && sourceCalls === previous; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(sourceCalls > previous, 'the actual source request must be running before stop or revocation');
}

test('automatic policy has a project default, explicit overrides, human authorship and version conflicts', async () => {
  await project('policy');
  const state = await readAutomation('policy');
  assert.equal(allowsAutomatic(state.policy, 'search'), false);
  await assert.rejects(() => saveAutomationPolicy('policy', { actor: 'ai', expectedVersion: 1, policy: { enabled: true, overrides: {}, agentMode: 'specialists' } }), { code: 'HUMAN_INPUT_REQUIRED' });
  const next = await enable('policy', { selection: 'manual', replication: 'auto' });
  assert.equal(allowsAutomatic(next.policy, 'search'), true);
  assert.equal(allowsAutomatic(next.policy, 'selection'), false);
  assert.equal(allowsAutomatic({ ...next.policy, enabled: false }, 'replication'), true);
  await assert.rejects(() => saveAutomationPolicy('policy', { actor: 'human', expectedVersion: 1, policy: next.policy }), { code: 'VERSION_CONFLICT' });
  assert.equal(next.audit[0].actor, 'human');
});

test('manual confirmation pauses, can be approved once, and resume does not regenerate completed work', async () => {
  await project('manual');
  await startAutomation('manual', { actor: 'human', question: 'Question', targetStage: 'search' }, runtime);
  let state = await settled('manual');
  assert.equal(state.session.status, 'waiting_confirmation');
  assert.equal((await getResearchWorkflow('manual')).currentStage, 'direction');
  await assert.rejects(() => automaticWorkflowDecision('manual', { sessionId: state.session.id, stageId: 'direction' }), { code: 'AUTOMATION_CONFIRMATION_REQUIRED' });
  let workflow = await getResearchWorkflow('manual');
  await approveResearchWorkflow('manual', { actor: 'human', stageId: 'direction', expectedVersion: workflow.version });
  await enable('manual');
  await resumeAutomation('manual', { actor: 'human' }, runtime);
  state = await settled('manual');
  assert.equal(state.session.status, 'completed', JSON.stringify(state.session));
  assert.equal((await listHarnessRuns('manual')).length, 2);
});

test('a real Node reproduction is followed by a distinct analysis Agent without human-confirmed Evidence', async () => {
  const root = await project('pipeline'); await enable('pipeline');
  await startAutomation('pipeline', { actor: 'human', question: 'Question', executionPlan: plan }, runtime);
  const state = await settled('pipeline');
  assert.equal(state.session.status, 'completed', JSON.stringify(state.session));
  const step = state.session.steps.find(step => step.stage === 'replication');
  const run = await getExperimentRun('pipeline', step.experimentRunId);
  assert.equal(run.status, 'completed'); assert.equal(run.metrics[0].value, 4);
  assert.equal(run.approval.actor, 'system'); assert.equal(run.approval.authorization.sessionId, state.session.id);
  assert.ok((await getEvidenceLedger('pipeline')).entries.every(entry => !['verified', 'human-confirmed'].includes(entry.verificationStatus)));
  const workflow = await getResearchWorkflow('pipeline');
  assert.equal(workflow.currentStage, 'method');
  assert.equal(workflow.stages.find(stage => stage.id === 'selection').data.task.humanDecision, null);
  const runs = await listHarnessRuns('pipeline');
  assert.ok(runs.some(run => run.role === 'screening-agent' && run.stage === 'selection'));
  const analysis = runs.find(run => run.role === 'innovation-agent');
  assert.ok(JSON.stringify(analysis.request.input.replicationResults).includes(run.id));
  assert.equal(await readFile(path.join(root, 'data.json'), 'utf8'), '[2,4,6]');
  assert.ok(!JSON.stringify(await readAutomation('pipeline')).includes('apiKey'));
});

test('execution override waits at the real Run and revoked capability still refuses automatic execution', async () => {
  await project('execution-manual'); await enable('execution-manual', { execution: 'manual' });
  await startAutomation('execution-manual', { actor: 'human', question: 'Question', executionPlan: plan }, runtime);
  let state = await settled('execution-manual');
  assert.equal(state.session.status, 'waiting_confirmation'); assert.equal(state.session.error.details.part, 'execution');
  const id = state.session.steps.find(step => step.stage === 'replication').experimentRunId;
  assert.equal((await getExperimentRun('execution-manual', id)).status, 'awaiting_approval');
  await enable('execution-manual'); await resumeAutomation('execution-manual', { actor: 'human' }, runtime);
  state = await settled('execution-manual'); assert.equal(state.session.status, 'completed', JSON.stringify(state.session));
  assert.equal(state.session.steps.find(step => step.stage === 'replication').experimentRunId, id);
  await project('denied', false); await enable('denied');
  await startAutomation('denied', { actor: 'human', question: 'Question', executionPlan: plan }, runtime);
  state = await settled('denied'); assert.equal(state.session.status, 'blocked'); assert.equal(state.session.error.code, 'EXPERIMENT_EXECUTION_DENIED');
});

test('the full eight-stage chain hands two actual experiments to the writing Agent', async () => {
  await project('full-chain'); await enable('full-chain');
  const paperId = `paper-${createHash('sha1').update('https://arxiv.org/abs/2601.00001').digest('hex').slice(0, 20)}`;
  const fullRuntime = { ...runtime, testInput: { ...runtime.testInput,
    method: { fakeResponse: JSON.stringify({ stage: 'method_proposals', selectedIdeaId: 'idea1', proposals: [{ id: 'method1', name: 'Held-out comparison', ideaId: 'idea1', description: 'Compare means on a separate sample.', components: ['Mean'], baselines: ['original'], metrics: ['mean'] }], recommendation: 'method1', humanDecisionRequired: true }) },
    experiment_plan: { fakeResponse: JSON.stringify({ stage: 'experiment_plan', methodId: 'method1', datasetIds: ['data.json'], baselineIds: ['original'], metrics: [{ name: 'mean', direction: 'target', target: 4 }], successCriteria: ['Record the actual result'], humanApprovalRequired: true }) },
    writing: { fakeResponse: JSON.stringify({ stage: 'writing_brief', title: 'Pending research brief', claims: [{ id: 'claim1', text: 'The controlled sample has mean four; scientific support remains pending.', evidenceIds: [paperId], confidence: 0.5 }], outline: ['Question', 'Methods', 'Results', 'Limitations'], citationPaperIds: ['p1'], limitations: ['Controlled fixture, not a real paper reproduction.'], unsupportedClaims: ['claim1 requires verification'] }) }
  } };
  await startAutomation('full-chain', { actor: 'human', question: 'Question', targetStage: 'writing', executionPlan: plan }, fullRuntime);
  const state = await settled('full-chain');
  assert.equal(state.session.status, 'completed', JSON.stringify(state.session));
  assert.equal(state.session.steps.length, 8);
  assert.ok(state.session.steps.every(step => step.status === 'completed'));
  const experiments = state.session.steps.filter(step => step.experimentRunId);
  assert.equal(experiments.length, 2);
  assert.notEqual(experiments[0].experimentRunId, experiments[1].experimentRunId);
  assert.ok(experiments.every(step => step.result.status === 'completed' && step.result.metrics[0].value === 4));
  const writer = (await listHarnessRuns('full-chain')).find(run => run.role === 'research-writer');
  assert.equal(writer.request.input.replicationRun.id, experiments[0].experimentRunId);
  assert.equal(writer.request.input.experimentRun.id, experiments[1].experimentRunId);
  assert.equal((await getResearchWorkflow('full-chain')).status, 'completed');
  assert.ok((await getEvidenceLedger('full-chain')).entries.every(entry => !['verified', 'human-confirmed'].includes(entry.verificationStatus)));
});

test('stop and revoke during source lookup prevent later side effects and a duplicate start', async () => {
  await project('stop'); await enable('stop'); let release;
  sourceWait = new Promise(resolve => { release = resolve; });
  const calls = sourceCalls;
  await startAutomation('stop', { actor: 'human', question: 'Question', skipReplication: true }, runtime);
  await waitForSource(calls);
  await assert.rejects(() => startAutomation('stop', { actor: 'human' }, runtime), { code: 'AUTOMATION_ACTIVE' });
  await stopAutomation('stop', { actor: 'human' }); release(); sourceWait = null;
  const state = await settled('stop'); assert.equal(state.session.status, 'stopped');
  assert.equal((await getResearchWorkflow('stop')).currentStage, 'search');
  assert.equal((await listHarnessRuns('stop')).length, 2);
});

test('automation HTTP validates actor and does not accept persisted provider configuration', async () => {
  await project('http'); const app = Fastify(); registerResearchWorkflowRoutes(app);
  const base = '/api/projects/http/research-workflow/automation';
  const before = (await app.inject({ method: 'GET', url: base })).json(); assert.equal(before.policy.enabled, false);
  const invalid = await app.inject({ method: 'PATCH', url: base, payload: { actor: 'ai', expectedVersion: 1, policy: { enabled: true, overrides: {}, agentMode: 'specialists' } } }); assert.equal(invalid.statusCode, 403);
  const missingActor = await app.inject({ method: 'POST', url: base + '/start', payload: {} }); assert.equal(missingActor.statusCode, 403);
  const secret = await app.inject({method:'POST',url:base+'/start',payload:{actor:'human',executionPlan:{...plan,apiKey:'not-for-storage'}}}); assert.equal(secret.statusCode,400);
  assert.equal((await readAutomation('http')).session,null);
  await app.close();
});

test('revoking automatic confirmation while a source request runs stops at the current stage', async () => {
  await project('revoke'); await enable('revoke'); let release;
  sourceWait = new Promise(resolve => { release = resolve; });
  const calls = sourceCalls;
  await startAutomation('revoke',{actor:'human',question:'Question',skipReplication:true},runtime);
  await waitForSource(calls);
  const state=await readAutomation('revoke');
  await saveAutomationPolicy('revoke',{actor:'human',expectedVersion:state.version,policy:{...state.policy,enabled:false}});
  release();sourceWait=null;
  const finished=await settled('revoke');assert.equal(finished.session.status,'waiting_confirmation');
  assert.equal((await getResearchWorkflow('revoke')).currentStage,'search');
  assert.equal((await listHarnessRuns('revoke')).length,2);
});

test('an interrupted stopping session exposes continuation without mutating its persisted record', async () => {
  const root = await project('restart-stop');
  await mutateAutomation('restart-stop', state => { state.session = { id: 'old-session', status: 'stopping', stopRequested: true, steps: [] }; });
  const file = path.join(root, '.scienceprism/research-automation.json');
  const before = await readFile(file, 'utf8');
  assert.equal((await getAutomation('restart-stop')).session.status, 'stopped');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('failed model outputs remain blocked and an explicit retry can repair the stage', async () => {
  await project('bad-output');await enable('bad-output');
  await startAutomation('bad-output',{actor:'human',question:'Question',targetStage:'search'},{...runtime,testInput:{search:{fakeResponse:'invalid output'}}});
  const before=await settled('bad-output');assert.equal(before.session.status,'blocked');
  assert.equal((await getResearchWorkflow('bad-output')).currentStage,'search');
  await resumeAutomation('bad-output',{actor:'human'},runtime);
  const after=await settled('bad-output');assert.equal(after.session.status,'completed',JSON.stringify(after.session));
  assert.equal((await listHarnessRuns('bad-output')).length,4);
});

test('automatic manuscript application keeps the original version guard and respects rejected proposals', async () => {
  const root=await project('patches');
  await writeFile(path.join(root,'main.tex'),'original');
  const result=await runHarnessRequest({projectId:'patches',source:'editor',task:'custom',role:'project-agent',capabilities:['project.read','patch.propose'],adapter:'fake',fakePatches:[{path:'main.tex',content:'proposal'}]});
  // grant patch capability explicitly; automation alone never grants it
  assert.equal(result.ok,false);
  await writeFile(path.join(root,'.scienceprism/project-constraints.json'),JSON.stringify({capabilities:['project.read','patch.propose']}));
  const proposal=await runHarnessRequest({projectId:'patches',source:'editor',task:'custom',role:'project-agent',capabilities:['project.read','patch.propose'],adapter:'fake',fakePatches:[{path:'main.tex',content:'proposal'}]});
  await assert.rejects(()=>automaticallyApplyPatches('patches',proposal.runId),{code:'AUTOMATION_CONFIRMATION_REQUIRED'});
  await enable('patches');await writeFile(path.join(root,'main.tex'),'human edit');
  await assert.rejects(()=>automaticallyApplyPatches('patches',proposal.runId),error=>/VERSION|CONFLICT/.test(error.code));
  assert.equal(await readFile(path.join(root,'main.tex'),'utf8'),'human edit');
  const rejected=await runHarnessRequest({projectId:'patches',source:'editor',task:'custom',role:'project-agent',capabilities:['project.read','patch.propose'],adapter:'fake',fakePatches:[{path:'main.tex',content:'unwanted'}]});
  await decideHarnessRun('patches',rejected.runId,{decision:'reject',actor:'human'});
  await assert.rejects(()=>automaticallyApplyPatches('patches',rejected.runId),{code:'AUTOMATION_PATCH_REJECTED'});
  assert.equal(await readFile(path.join(root,'main.tex'),'utf8'),'human edit');
});

test('a workflow save failure resumes from durable model and search results without repeating them', async t => {
  await project('save-recovery'); await enable('save-recovery');
  const interrupted = interruptSearchSave(t);
  const beforeCalls = sourceCalls;
  await startAutomation('save-recovery', { actor: 'human', question: 'Question', targetStage: 'search' }, runtime);
  const blocked = await settled('save-recovery'); assert.equal(blocked.session.status, 'blocked'); assert(interrupted());
  const step = blocked.session.steps.find(step => step.stage === 'search');
  assert.equal(step.calls.length, 1); assert.equal(step.searches.length, 1);
  const model = await import('../src/services/harnessRuntime/index.js');
  assert.equal((await model.getHarnessRun('save-recovery', step.calls[0].runId)).status, 'completed');
  const ledgerPath = path.join(process.env.SCIENCEPRISM_DATA_DIR, 'save-recovery/.scienceprism/harness-runs.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.runs.find(run => run.id === step.calls[0].runId).retainedWorkspace = { format: 'harness-workspace-v1', attempt: 1 };
  await writeFile(ledgerPath, JSON.stringify(ledger));
  assert.equal(step.handoff.parentRunId, blocked.session.coordinatorRunId);
  const sourceAfterFailure = sourceCalls; assert(sourceAfterFailure > beforeCalls);
  await resumeAutomation('save-recovery', { actor: 'human' }, runtime);
  const done = await settled('save-recovery'); assert.equal(done.session.status, 'completed', JSON.stringify(done.session));
  assert.equal(sourceCalls, sourceAfterFailure); assert.equal((await listHarnessRuns('save-recovery')).length, 2);
  const runs = await listHarnessRuns('save-recovery');
  assert(runs.filter(run => run.kind !== 'research-coordinator').every(run => run.parentRunId === done.session.coordinatorRunId));
  assert.equal((await model.getHarnessRun('save-recovery', done.session.coordinatorRunId)).status, 'completed');
});

test('a ready recovery with a retained slot still requires trusted reconciliation before queueing', async t => {
  await project('ready-slot'); await enable('ready-slot');
  interruptSearchSave(t);
  await startAutomation('ready-slot', { actor: 'human', question: 'Question', targetStage: 'search' }, runtime);
  const blocked = await settled('ready-slot'); assert.equal(blocked.session.status, 'blocked');
  const ledgerPath = path.join(process.env.SCIENCEPRISM_DATA_DIR, 'ready-slot/.scienceprism/harness-runs.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const original = ledger.runs.find(run => run.kind === 'research-stage');
  // Deliberately inconsistent fixture: ready cannot bypass the retained slot,
  // and a fake adapter cannot supply a real retained recovery workspace.
  original.status = 'paused'; original.recovery = { status: 'ready' };
  original.cleanup = { modelSlotRetained: true };
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await assert.rejects(() => resumeAutomation('ready-slot', { actor: 'human', recoverExisting: true }, runtime), { code: 'AUTOMATION_RUN_UNRESOLVED' });
  const saved = await readAutomation('ready-slot'); assert.equal(saved.session.status, 'blocked');
  assert.equal(saved.session.steps.find(step => step.stage === 'search').calls[0].runId, original.id);
  assert.equal((await listHarnessRuns('ready-slot')).length, 2);
});

test('the research coordinator cannot independently run, replay, cancel or approve model work', async () => {
  await project('coordinator-control');
  await startAutomation('coordinator-control', { actor: 'human', question: 'Question', targetStage: 'search' }, runtime);
  const state = await settled('coordinator-control'), id = state.session.coordinatorRunId;
  const model = await import('../src/services/harnessRuntime/index.js');
  for (const command of [model.startHarnessRun, model.pauseHarnessRun, model.cancelHarnessRun, model.replayHarnessRun, model.recoverHarnessRun]) {
    await assert.rejects(() => command('coordinator-control', id), { code: 'AUTOMATION_OWNS_COORDINATOR' });
  }
  await assert.rejects(() => model.decideHarnessRun('coordinator-control', id, { decision: 'accept' }), { code: 'AUTOMATION_OWNS_COORDINATOR' });
  assert.equal((await model.getHarnessRun('coordinator-control', id)).status, 'created');
});

test('changed upstream source data blocks continuation before another specialist is called', async () => {
  const root = await project('handoff-drift'); await enable('handoff-drift', { selection: 'manual' });
  await startAutomation('handoff-drift', { actor: 'human', question: 'Question', skipReplication: true }, runtime);
  const waiting = await settled('handoff-drift'); assert.equal(waiting.session.status, 'waiting_confirmation');
  const before = await listHarnessRuns('handoff-drift');
  const file = path.join(root, '.scienceprism/research-workflow.json'), workflow = JSON.parse(await readFile(file, 'utf8'));
  workflow.stages.find(stage => stage.id === 'search').data.papers[0].title = 'Changed fixture source';
  await writeFile(file, JSON.stringify(workflow));
  await enable('handoff-drift'); await resumeAutomation('handoff-drift', { actor: 'human' }, runtime);
  const blocked = await settled('handoff-drift'); assert.equal(blocked.session.error.code, 'AUTOMATION_HANDOFF_INPUT_CHANGED');
  assert.equal((await listHarnessRuns('handoff-drift')).length, before.length);
});

test('a restarted unknown stage Run stays unresolved instead of creating a replacement', async t => {
  const root = await project('unknown-stage'); await enable('unknown-stage'); interruptSearchSave(t);
  await startAutomation('unknown-stage', { actor: 'human', question: 'Question', targetStage: 'search' }, runtime);
  const blocked = await settled('unknown-stage'); assert.equal(blocked.session.status, 'blocked');
  const calls = sourceCalls, file = path.join(root, '.scienceprism/harness-runs.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  const run = ledger.runs.find(run => run.kind === 'research-stage');
  run.status = 'running'; run.runtimeInstanceId = 'old-service-fixture';
  await writeFile(file, JSON.stringify(ledger));
  await resumeAutomation('unknown-stage', { actor: 'human' }, runtime);
  const after = await settled('unknown-stage'); assert.equal(after.session.error.code, 'AUTOMATION_RUN_UNRESOLVED');
  assert.equal((await listHarnessRuns('unknown-stage')).length, 2); assert.equal(sourceCalls, calls);
});

test('stage tasks and coordinator delegation require the trusted owning chain', async () => {
  await project('stage-control'); await enable('stage-control', { selection: 'manual' });
  await startAutomation('stage-control', { actor: 'human', question: 'Question', skipReplication: true }, runtime);
  const state = await settled('stage-control'), runs = await listHarnessRuns('stage-control');
  const child = runs.find(run => run.kind === 'research-stage'), model = await import('../src/services/harnessRuntime/index.js');
  for (const command of [model.startHarnessRun, model.pauseHarnessRun, model.cancelHarnessRun, model.replayHarnessRun, model.recoverHarnessRun]) await assert.rejects(() => command('stage-control', child.id), { code: 'AUTOMATION_OWNS_STAGE' });
  await assert.rejects(() => model.decideHarnessRun('stage-control', child.id, { decision: 'accept' }), { code: 'AUTOMATION_OWNS_STAGE' });
  await assert.rejects(() => model.createHarnessRun('stage-control', { parentRunId: state.session.coordinatorRunId, delegationTask: 'forged', automationSessionId: state.session.id, capabilities: ['project.read'] }), { code: 'AUTOMATION_OWNS_STAGE' });
  assert.equal((await listHarnessRuns('stage-control')).length, runs.length);
});

test('a changed specialist mode cannot execute under a handoff for the old role', async () => {
  await project('role-drift'); await enable('role-drift', { selection: 'manual' });
  await startAutomation('role-drift', { actor: 'human', question: 'Question', skipReplication: true }, runtime);
  const before = await settled('role-drift'), count = (await listHarnessRuns('role-drift')).length;
  await saveAutomationPolicy('role-drift', { actor: 'human', expectedVersion: before.version, policy: { enabled: true, overrides: {}, agentMode: 'generalist' } });
  await resumeAutomation('role-drift', { actor: 'human' }, runtime);
  const after = await settled('role-drift'); assert.equal(after.session.error.code, 'AUTOMATION_HANDOFF_OWNER_CHANGED');
  assert.equal((await listHarnessRuns('role-drift')).length, count);
});
