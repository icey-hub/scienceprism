import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Execute the browser transport itself, without importing React or simulating its implementation.
const source = await readFile(new URL('../../frontend/src/api/workflowTransport.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { workflowSession, WorkflowRequestError } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('workflow transport preserves concurrency, human decisions and stage identity', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, workflow: { version: 8 } }));
  });
  const version = { expectedVersion: 7, idempotencyKey: 'same-operation' };
  await workflowSession.saveInstructions('project /1', 'innovation', 'retain draft', version);
  assert.equal(requests[0].url, '/api/projects/project%20%2F1/research-workflow');
  assert.deepEqual(requests[0].body, { actor: 'human', stage: 'ideation', humanInstructions: 'retain draft', ...version });
  assert.equal(requests[0].method, 'PATCH');
  await workflowSession.approve('p', 'replication', { decision: 'skip', note: 'missing dataset' }, version);
  assert.deepEqual(requests[1].body, { actor: 'human', stage: 'replication', decision: 'skip', note: 'missing dataset', ...version });
  assert.match(requests[1].url, /\/approve$/);
  await workflowSession.run('p', 'generate-ideas', { paperIds: ['paper-1'] }, version);
  assert.deepEqual(requests[2].body, { paperIds: ['paper-1'], action: 'generate-ideas', ...version });
  await workflowSession.reset('p', version);
  assert.deepEqual(requests[3].body, { actor: 'human', ...version });
  await workflowSession.approve('p', 'innovation', { decision: 'reject', note: 'Needs stronger evidence' }, version);
  assert.deepEqual(requests[4].body, { actor: 'human', stage: 'ideation', decision: 'reject', note: 'Needs stronger evidence', ...version });
  assert.match(requests[4].url, /\/approve$/);
});

test('workflow transport exposes conflicts and refuses failed payloads or unreadable errors', async (t) => {
  const responses = [
    new Response(JSON.stringify({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Reload before saving.' } }), { status: 409 }),
    new Response(JSON.stringify({ ok: false, error: 'Stage is locked.' })),
    new Response('unavailable', { status: 503 })
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await assert.rejects(workflowSession.load('p'), (error) => error instanceof WorkflowRequestError && error.status === 409 && error.code === 'VERSION_CONFLICT' && error.message === 'Reload before saving.');
  await assert.rejects(workflowSession.load('p'), /Stage is locked/);
  await assert.rejects(workflowSession.load('p'), /503:研究流程请求失败/);
});
