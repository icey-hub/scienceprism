import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectRoot, withWorkflowLock } from '../researchWorkflow/repository.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
const file = '.scienceprism/validation-campaigns.json';
export async function readCampaigns(projectId) {
  const root = await resolveProjectRoot(projectId);
  try {
    const document = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    if (document.schemaVersion !== 1 || document.projectId !== projectId || !Array.isArray(document.campaigns)) throw new Error('Invalid campaign document');
    return document;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, projectId, campaigns: [] };
    throw new ResearchWorkflowError(500, 'VALIDATION_CAMPAIGN_CORRUPT', '创新试验批次记录损坏，请保留原记录。');
  }
}
export async function mutateCampaigns(projectId, callback) {
  return withWorkflowLock(projectId, async () => {
    const document = await readCampaigns(projectId), result = await callback(document), root = await resolveProjectRoot(projectId);
    const target = path.join(root, file), temporary = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
    return structuredClone(result);
  });
}
