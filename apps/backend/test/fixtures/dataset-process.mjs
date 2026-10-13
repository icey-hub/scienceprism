import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createDatasetService } from '../../src/services/datasets/index.js';

const projectId = process.env.DATASET_PROBE_PROJECT;
if (!projectId) throw new Error('An isolated dataset project is required.');
const signed = 'https://cdn-lfs.hf.co/fixed-data?signature=fixture-private-signature';
let service;
service = createDatasetService({ download: async (_url, { destination, signal, onProgress }) => {
  await fsp.writeFile(destination, 'abc', { mode: 0o600 });
  await onProgress({ receivedBytes: 3, totalBytes: 6, etag: '"fixed-v1"', resolvedUrl: signed });
  const jobs = await service.listJobs(projectId), job = jobs[0];
  if (job.status !== 'running') throw new Error('The child must really be acquiring data.');
  fs.writeSync(1, JSON.stringify({ pid: process.pid, projectId, jobId: job.id, receivedBytes: job.receivedBytes }) + '\n');
  return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
} });
await service.startDownload(projectId, { url: `https://huggingface.co/datasets/owner/data/resolve/${'a'.repeat(40)}/data.txt`, filename: 'data.txt', maxBytes: 6 });
setInterval(() => {}, 1000);
