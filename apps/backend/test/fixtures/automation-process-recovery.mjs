import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureRuntime = { adapter: 'fake', testInput: { search: { fakeResponse: JSON.stringify({ stage: 'search_strategy',
  researchQuestion: 'Question', humanDirection: 'Question', queries: ['Question'], sources: ['arxiv'], rationale: 'Fixed process recovery fixture' }) } } };

export async function incrementFixtureCounter(projectId, field) {
  const target = path.join(process.env.SCIENCEPRISM_DATA_DIR, projectId, '.scienceprism', 'process-probe-counts.json');
  let value = { adapter: 0, source: 0 }; try { value = JSON.parse(await fsp.readFile(target, 'utf8')); } catch (reason) { if (reason.code !== 'ENOENT') throw reason; }
  value[field]++; await fsp.writeFile(target, JSON.stringify(value));
}
export async function installFixedSource() {
  const { registerResearchSourceAdapter } = await import('../../src/services/researchSources/index.js');
  registerResearchSourceAdapter({ id: 'arxiv', label: 'Fixed local process recovery source', async search({ projectId, beforeRequest }) {
    await beforeRequest?.({ source: 'arxiv', url: 'https://export.arxiv.org/api/query' });
    // Some source adapters do not receive projectId. The fixture is installed
    // for one isolated project at a time, never for the user's real project.
    await incrementFixtureCounter(projectId || process.env.PROCESS_PROBE_PROJECT, 'source');
    return [{ id: 'p1', title: 'Process recovery fixture', abstract: 'A fixed result to exercise durable search receipts.', authors: ['Fixture Author'],
      year: 2025, url: 'https://arxiv.org/abs/2601.00001', venue: 'Fixture Conference', publicationType: 'conference', peerReviewed: true, source: 'arxiv' }];
  } });
}

async function main() {
  const projectId = process.env.PROCESS_PROBE_PROJECT, mode = process.env.PROCESS_PROBE_MODE;
  if (!projectId || !['hold', 'save-crash'].includes(mode)) throw new Error('A fixed process recovery mode and isolated project are required.');
  const root = path.join(process.env.SCIENCEPRISM_DATA_DIR, projectId), send = value => fs.writeSync(1, JSON.stringify(value) + '\n');
  const harness = await import('../../src/services/harnessRuntime/index.js');
  const { fakeHarnessAdapter } = await import('../../src/services/harnessRuntime/adapters/fakeAdapter.js');
  const { startAutomation, getAutomation } = await import('../../src/services/researchAutomation/index.js');
  const { readAutomation, saveAutomationPolicy } = await import('../../src/services/researchAutomation/policy.js');
  const { inspectAutomationOwner } = await import('../../src/services/researchAutomation/owner.js');
  await installFixedSource(); let completedRunId, createdRunId;
  harness.registerHarnessAdapter({ ...fakeHarnessAdapter, async run(context) {
    await incrementFixtureCounter(projectId, 'adapter');
    if (mode === 'hold' && context.request.task === 'research:search_strategy') {
      const policy = await context.readPolicy();
      const { createRetainedWorkspace } = await import('../../src/services/harnessRuntime/retainedWorkspace.js');
      const { readHarnessRuns, writeHarnessRuns, withHarnessRunLock } = await import('../../src/services/harnessRuntime/repository.js');
      const actual = await harness.getHarnessRun(projectId, policy.runId);
      // A real retained owner/checkpoint annotates this *unfinished fake* Run.
      // This exercises interruption accounting, not DSH model/workspace resume.
      const retained = await createRetainedWorkspace({ projectRoot: root, runId: actual.id, attempt: actual.attempt, expectedVersions: { runtime: 'process-fixture-v1' } });
      await retained.update({ status: 'running', runtimeProcess: { pid: process.pid, stopConfirmed: false } });
      await withHarnessRunLock(projectId, async () => {
        const document = await readHarnessRuns(root, projectId), run = document.runs.find(value => value.id === actual.id);
        if (run.status !== 'running') throw new Error('The fake adapter must actually be executing.');
        run.retainedWorkspace = { format: 'scienceprism-harness-retention-v1', attempt: actual.attempt }; await writeHarnessRuns(root, document);
      });
      const state = await getAutomation(projectId), owner = inspectAutomationOwner({ projectRoot: root });
      send({ kind: 'ready', mode, pid: process.pid, owner, sessionId: state.session.id, coordinatorRunId: state.session.coordinatorRunId,
        runningRunId: actual.id, completedRunId, createdRunId });
      return new Promise(() => {});
    }
    return fakeHarnessAdapter.run(context);
  } });
  if (mode === 'hold') {
    const completed = await harness.runHarnessRequest({ projectId, adapter: 'fake', task: 'process-fixture-complete', capabilities: ['project.read'], fakeResponse: 'actually completed fixture' });
    if (!completed.ok || (await harness.getHarnessRun(projectId, completed.runId)).status !== 'completed') throw new Error('The fixed adapter must really complete its first Run.');
    completedRunId = completed.runId;
    createdRunId = (await harness.createHarnessRun(projectId, { adapter: 'fake', task: 'process-fixture-created', capabilities: ['project.read'] })).id;
  } else {
    const rename = fsp.rename.bind(fsp); let interrupted = false;
    fsp.rename = async (from, to) => {
      if (!interrupted && String(to).endsWith('research-workflow.json')) {
        const document = JSON.parse(await fsp.readFile(from, 'utf8'));
        if (document.stages.find(stage => stage.id === 'search').data.task) {
          interrupted = true; const state = await getAutomation(projectId), step = state.session.steps.find(step => step.stage === 'search');
          const actual = await harness.getHarnessRun(projectId, step.calls[0].runId);
          if (actual.status !== 'completed') throw new Error('Search strategy must truly finish before workflow-save interruption.');
          send({ kind: 'ready', mode, pid: process.pid, sessionId: state.session.id, coordinatorRunId: state.session.coordinatorRunId,
            completedRunId: actual.id, searchSessionId: step.searches[0].searchSessionId });
          return new Promise(() => {});
        }
      }
      return rename(from, to);
    };
  }
  const policy = await readAutomation(projectId);
  await saveAutomationPolicy(projectId, { actor: 'human', expectedVersion: policy.version, policy: { enabled: true, overrides: {}, agentMode: 'specialists' } });
  await startAutomation(projectId, { actor: 'human', question: 'Question', targetStage: 'search' }, fixtureRuntime);
  setInterval(() => {}, 1000);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(reason => { fs.writeSync(2, `${reason.stack || reason}\n`); process.exitCode = 1; });
}
