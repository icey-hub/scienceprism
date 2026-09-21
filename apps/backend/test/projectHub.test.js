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
});

test('task center preserves logs and exposes failure summary', async () => {
  const projectId = 'task-project';
  await createProject(projectId);
  const task = await createTask(projectId, { kind: 'compile', title: 'Compile main.tex', status: 'failed', progress: 100, error: { message: 'No PDF generated.' }, log: ['started', 'failed'] });
  const tasks = await listTasks(projectId);
  assert.equal(tasks.find((item) => item.id === task.id)?.log.at(-1), 'failed');
  assert.equal((await getTaskSummary(projectId)).failed, 1);
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
