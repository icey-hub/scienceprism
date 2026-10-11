import assert from 'node:assert/strict';
import test from 'node:test';
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
registerResearchSourceAdapter({ id: 'arxiv', label: 'Controlled source', async search() {
  if (sourceWait) await sourceWait;
  return [{ id: 'p1', title: 'Controlled paper', abstract: 'Testing actual pipeline plumbing.', authors: ['Fixture Author'], year: 2025, url: 'https://arxiv.org/abs/2601.00001', venue: 'Test Conference', publicationType: 'conference', peerReviewed: true, source: 'arxiv' }];
} });
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
  assert.equal((await listHarnessRuns('manual')).length, 1);
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
  await startAutomation('stop', { actor: 'human', question: 'Question', skipReplication: true }, runtime);
  for (let i = 0; i < 100; i++) { if ((await getAutomation('stop')).session.currentStage === 'search') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  await assert.rejects(() => startAutomation('stop', { actor: 'human' }, runtime), { code: 'AUTOMATION_ACTIVE' });
  await stopAutomation('stop', { actor: 'human' }); release(); sourceWait = null;
  const state = await settled('stop'); assert.equal(state.session.status, 'stopped');
  assert.equal((await getResearchWorkflow('stop')).currentStage, 'search');
  assert.equal((await listHarnessRuns('stop')).length, 1);
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
  await startAutomation('revoke',{actor:'human',question:'Question',skipReplication:true},runtime);
  for(let i=0;i<100;i++){if((await getAutomation('revoke')).session.currentStage==='search')break;await new Promise(resolve=>setTimeout(resolve,10));}
  const state=await readAutomation('revoke');
  await saveAutomationPolicy('revoke',{actor:'human',expectedVersion:state.version,policy:{...state.policy,enabled:false}});
  release();sourceWait=null;
  const finished=await settled('revoke');assert.equal(finished.session.status,'waiting_confirmation');
  assert.equal((await getResearchWorkflow('revoke')).currentStage,'search');
  assert.equal((await listHarnessRuns('revoke')).length,1);
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
  assert.equal((await listHarnessRuns('bad-output')).length,3);
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
