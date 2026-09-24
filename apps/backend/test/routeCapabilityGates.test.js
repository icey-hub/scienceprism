import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'scienceprism-route-gates-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { registerPlotRoutes } = await import('../src/routes/plot.js');
const { registerTransferRoutes } = await import('../src/routes/transfer.js');
const { registerVisionRoutes } = await import('../src/routes/vision.js');

async function createProject(id, capabilities) {
  const root = path.join(dataDir, id);
  await mkdir(path.join(root, '.scienceprism'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: 'route gate test' }));
  await writeFile(
    path.join(root, '.scienceprism', 'project-constraints.json'),
    JSON.stringify({ capabilities })
  );
  return root;
}

function multipartBody(boundary, fields) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      chunks.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value);
    } else {
      chunks.push(
        `--${boundary}`,
        `Content-Disposition: form-data; name="${name.name}"; filename="${name.filename}"`,
        `Content-Type: ${name.contentType}`,
        '',
        name.value
      );
    }
  }
  chunks.push(`--${boundary}--`, '');
  return chunks.join('\r\n');
}

test('plot generation is denied when the project does not grant experiment.execute', async () => {
  const projectId = 'gate-plot-denied';
  await createProject(projectId, ['project.read', 'patch.propose']);

  const app = Fastify();
  registerPlotRoutes(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/plot/from-table',
    payload: { projectId, tableLatex: '\\begin{tabular}{cc}a & b\\end{tabular}' }
  });

  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'CAPABILITY_DENIED', 'model-authored Python must not run without an explicit capability');
  await app.close();
});

test('plot generation is denied when the execution feature flag is off', async () => {
  const projectId = 'gate-plot-flag';
  const root = await createProject(projectId, ['project.read', 'patch.propose', 'experiment.execute']);
  await writeFile(
    path.join(root, '.scienceprism', 'project-constraints.json'),
    JSON.stringify({ capabilities: ['project.read', 'patch.propose', 'experiment.execute'], featureFlags: { experimentExecution: false } })
  );

  const app = Fastify();
  registerPlotRoutes(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/plot/from-table',
    payload: { projectId, tableLatex: '\\begin{tabular}{cc}a & b\\end{tabular}' }
  });

  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'FEATURE_FLAG_DISABLED');
  await app.close();
});

test('template transfer is denied when the project revokes patch.propose', async () => {
  const projectId = 'gate-transfer-denied';
  await createProject(projectId, ['project.read']);

  const app = Fastify();
  registerTransferRoutes(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/transfer/start',
    payload: { sourceProjectId: projectId, sourceMainFile: 'main.tex', targetTemplateId: 'unused', targetMainFile: 'main.tex' }
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'CAPABILITY_DENIED');
  await app.close();
});

test('storing a converted image is denied when the project revokes patch.propose', async () => {
  const projectId = 'gate-vision-denied';
  await createProject(projectId, ['project.read']);

  const boundary = '----scienceprismtest';
  const app = Fastify();
  await app.register(multipart);
  registerVisionRoutes(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/latex',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipartBody(boundary, {
      projectId,
      mode: 'equation',
      image: { name: 'image', filename: 'x.png', contentType: 'image/png', value: 'not-a-real-png' }
    })
  });

  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'CAPABILITY_DENIED');
  await app.close();
});
