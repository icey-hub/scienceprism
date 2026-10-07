import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-phase-seven-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { importPaper, listPapers, updatePaper } = await import('../src/services/projectHub/paperLibrary.js');
const { initializeProject, getProjectDashboard } = await import('../src/services/projectHub/dashboard.js');
const { createTask, getTaskSummary, listTasks } = await import('../src/services/projectHub/taskCenter.js');
const { getWritingQuality } = await import('../src/services/projectHub/writingQuality.js');
const { createWorkflowDocument } = await import('../src/services/researchWorkflow/stateMachine.js');
const { createStageTask, markStageTaskDecision } = await import('../src/services/researchWorkflow/stageTask.js');
const { writeWorkflowFile } = await import('../src/services/researchWorkflow/repository.js');

async function createProject(projectId) {
  const root = path.join(dataDir, projectId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId, name: 'Phase seven test' }));
  return root;
}

test('paper library deduplicates source records and keeps reading state', async () => {
  const projectId = 'library-project';
  await createProject(projectId);
  const first = await importPaper(projectId, {
    title: 'Grounded Retrieval', authors: ['A. Researcher'], year: 2024,
    arxivId: '2401.00001v1', url: 'https://arxiv.org/abs/2401.00001v1', source: 'arxiv'
  });
  const duplicate = await importPaper(projectId, {
    title: 'Grounded Retrieval', authors: ['A. Researcher', 'B. Researcher'], year: 2024,
    arxivId: '2401.00001v2', url: 'https://arxiv.org/abs/2401.00001v2', source: 'arxiv', tags: ['核心']
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await listPapers(projectId)).length, 1);
  const updated = await updatePaper(projectId, first.paper.id, { readingStatus: 'reading', favorite: true, notes: 'Read abstract.' });
  assert.equal(updated.paper.readingStatus, 'reading');
  assert.equal(updated.paper.favorite, true);
  assert.equal(updated.paper.evidenceId, first.paper.evidenceId);
  assert.ok((await getTaskSummary(projectId)).completed >= 2);
  const sourceRecords = updated.paper.sourceRecords;
  assert.ok(sourceRecords.some((record) => record.id === '2401.00001v1'));
  assert.ok(sourceRecords.some((record) => record.id === '2401.00001v2'));
  const { getEvidence } = await import('../src/services/evidenceLedger/index.js');
  const paperEvidence = await getEvidence(projectId, updated.paper.evidenceId);
  assert.equal(paperEvidence.verificationStatus, 'pending');
  assert.equal(paperEvidence.metadata.paperId, first.paper.id);
});

test('legacy checked metadata does not scientifically confirm paper Evidence', async () => {
  const projectId = 'library-source-check';
  await createProject(projectId);
  const imported = await importPaper(projectId, { title: 'Field check only', authors: ['A Researcher'], url: 'https://example.test/paper', source: 'fixture' });
  assert.equal(imported.paper.sourceCheck.status, 'checked');
  const checked = await updatePaper(projectId, imported.paper.id, { runSourceCheck: true });
  assert.equal(checked.paper.sourceCheck.status, 'checked');
  const { getEvidence } = await import('../src/services/evidenceLedger/index.js');
  assert.equal((await getEvidence(projectId, checked.paper.evidenceId)).verificationStatus, 'pending');
  const reimported = await importPaper(projectId, JSON.parse(JSON.stringify(checked.paper)));
  assert.equal(reimported.duplicate, true);
  assert.equal(reimported.paper.id, checked.paper.id);
  assert.equal(reimported.paper.evidenceId, checked.paper.evidenceId);
  assert.equal(reimported.paper.bibtex, checked.paper.bibtex);
});

test('duplicate imports preserve human metadata omitted by the source', async () => {
  const projectId = 'library-human-metadata';
  await createProject(projectId);
  const source = { title: 'Traceable paper', authors: ['A Researcher'], arxivId: '2401.01234v1', source: 'arxiv' };
  const first = await importPaper(projectId, source);
  const edited = await updatePaper(projectId, first.paper.id, {
    notes: 'Human note', annotations: [{ id: 'annotation-stable', text: 'Keep quote', page: 3 }],
    tags: ['review'], favorite: true, readingStatus: 'reading', bibtex: '@article{humanKey}'
  });
  const merged = await importPaper(projectId, { ...source, arxivId: '2401.01234v2' });
  assert.equal(merged.duplicate, true);
  for (const key of ['id', 'evidenceId', 'notes', 'annotations', 'tags', 'favorite', 'readingStatus', 'bibtex', 'createdAt', 'importedAt']) {
    assert.deepEqual(merged.paper[key], edited.paper[key], key);
  }
  const cleared = await importPaper(projectId, { ...source, notes: '', annotations: [], favorite: false });
  assert.equal(cleared.paper.notes, '');
  assert.deepEqual(cleared.paper.annotations, []);
  assert.equal(cleared.paper.favorite, false);
});

test('project initialization creates the first stage and dashboard projection', async () => {
  const projectId = 'dashboard-project';
  await createProject(projectId);
  const initialized = await initializeProject(projectId, {
    researchQuestion: 'How can evidence stay traceable?',
    scope: 'retrieval', model: 'deepseek-chat',
    constraints: { contextTokenBudget: 8000 }
  });
  assert.equal(initialized.workflow.currentStage, 'direction');
  assert.equal(initialized.workflow.stages[0].data.researchQuestion, 'How can evidence stay traceable?');
  const dashboard = await getProjectDashboard(projectId);
  assert.equal(dashboard.initialized, true);
  assert.equal(dashboard.progress.currentStage, 'direction');
  assert.equal(dashboard.nextAction.href, `/editor/${projectId}/research/direction`);
  assert.equal(dashboard.constraints.contextTokenBudget, 8000);
  assert.equal(dashboard.recentRuns.length, 0);
  assert.equal(dashboard.approvals.length, 1);
  assert.equal(dashboard.risks.find((item) => item.id === 'approval')?.detail, '当前阶段已满足提交条件，下一步需要人工决定。');
});

test('task center preserves logs and exposes failure summary', async () => {
  const projectId = 'task-project';
  await createProject(projectId);
  const task = await createTask(projectId, { kind: 'compile', title: 'Compile main.tex', status: 'failed', progress: 100, error: { message: 'No PDF generated.' }, log: ['started', 'failed'] });
  const tasks = await listTasks(projectId);
  assert.equal(tasks.find((item) => item.id === task.id)?.log.at(-1), 'failed');
  assert.equal((await getTaskSummary(projectId)).failed, 1);
});

test('task center reflects approved stages and pending writing approval without resetting timestamps', async () => {
  const projectId = 'stage-task-status-project';
  const root = await createProject(projectId);
  const workflow = createWorkflowDocument(projectId);
  workflow.currentStage = 'writing';
  for (const stage of workflow.stages) {
    if (stage.id === 'direction' || stage.id === 'experiment') {
      stage.status = 'approved';
      stage.updatedAt = '2026-09-25T10:00:00.000Z';
      stage.data.task = markStageTaskDecision(createStageTask({ stage: stage.id, createdAt: '2026-09-25T09:00:00.000Z' }), { decision: 'approve', at: stage.updatedAt });
    }
    if (stage.id === 'writing') {
      stage.status = 'awaiting_approval';
      stage.updatedAt = '2026-09-26T10:00:00.000Z';
      stage.data.task = createStageTask({ stage: stage.id, createdAt: stage.updatedAt });
    }
  }
  await writeWorkflowFile(root, workflow);
  const tasks = await listTasks(projectId);
  for (const stageId of ['direction', 'experiment']) {
    const task = tasks.find((item) => item.stage === stageId);
    assert.equal(task.status, 'approved', `${stageId} should not still be running or queued`);
    assert.equal(task.createdAt, '2026-09-25T09:00:00.000Z');
    assert.equal(task.updatedAt, '2026-09-25T10:00:00.000Z');
    assert.equal(task.progress, 100);
  }
  assert.equal(tasks.find((item) => item.stage === 'writing')?.status, 'awaiting_approval');
  const summary = await getTaskSummary(projectId);
  assert.equal(summary.active, 1);
  assert.equal(summary.completed, 2);
});

test('writing quality reports empty claims and source checks without inventing approval', async () => {
  const projectId = 'quality-project';
  const root = await createProject(projectId);
  await writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\\begin{document}\\cite{missing}\\end{document}\n');
  const quality = await getWritingQuality(projectId);
  assert.equal(quality.claims.totalClaims, 0);
  assert.deepEqual(quality.citations.missingKeys, ['missing']);
  assert.equal(quality.overall, 'needs-review');
});
