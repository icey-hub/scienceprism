import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
const data = await mkdtemp(path.join(os.tmpdir(), 'paper-task-projection-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { listTasks, cancelTask } = await import('../src/services/projectHub/taskCenter.js');

test('task center projects download jobs without copying state or inventing cancellation', async () => {
  const projectId = 'download-tasks';
  const root = path.join(data, projectId);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id: projectId, name: 'Attachment task fixture' }));
  const at = new Date().toISOString();
  const job = { id: 'pdf-download-fixture', paperId: 'paper-fixture', filename: 'example.pdf', status: 'running', sourceUrl: 'https://arxiv.org/pdf/1706.03762', receivedBytes: 100, totalBytes: 200, createdAt: at, updatedAt: at };
  const file = path.join(root, '.scienceprism/paper-attachments.json');
  const content = JSON.stringify({ schemaVersion: 1, projectId, attachments: [], jobs: [job] });
  await writeFile(file, content);
  const tasks = await listTasks(projectId, { kind: 'paper-download' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].error.code, 'ATTACHMENT_INTERRUPTED');
  assert.equal(tasks[0].metadata.jobId, job.id);
  assert.equal(tasks[0].retryable, true);
  await assert.rejects(cancelTask(projectId, tasks[0].id));
  assert.equal(await readFile(file, 'utf8'), content);
  await assert.rejects(readFile(path.join(root, '.scienceprism/tasks.json')), { code: 'ENOENT' });
});
