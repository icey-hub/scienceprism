import { getClaimEvidenceMatrix } from '../evidenceLedger/index.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { listHarnessRuns } from '../harnessRuntime/index.js';
import { listPapers } from './paperLibrary.js';
import { readHubJson, writeHubJson } from './repository.js';
import { auditCitations, readCitationManuscript } from './citationAudit.js';

const FILE = 'writing-quality.json';

function now() { return new Date().toISOString(); }
function normalizeTerm(value) { return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, ' '); }

function terminologyCheck(files, workflow) {
  const text = files.filter((file) => file.path.toLowerCase().endsWith('.tex')).map((file) => file.content).join('\n');
  const candidates = workflow?.stages?.find((stage) => stage.id === 'direction')?.data?.keywords || [];
  const terms = candidates.map(String).map((term) => term.trim()).filter((term) => term.length > 2);
  const variants = [];
  for (const term of terms) {
    const forms = new Set([term, term.replace(/[-_\s]+/g, ' '), term.replace(/[-_\s]+/g, '-')]);
    const used = [...forms].filter((form) => new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
    if (new Set(used.map(normalizeTerm)).size > 1) variants.push({ term, forms: used });
  }
  return { ok: variants.length === 0, variants };
}

export async function getWritingQuality(projectId) {
  const [matrix, workflow, papers, manuscript, runs, stored] = await Promise.all([
    getClaimEvidenceMatrix(projectId),
    getResearchWorkflow(projectId).catch((error) => error?.code === 'WORKFLOW_NOT_FOUND' ? null : Promise.reject(error)),
    listPapers(projectId, { limit: 5000 }),
    readCitationManuscript(projectId),
    listHarnessRuns(projectId, { stage: 'writing', limit: 20 }).catch(() => []),
    readHubJson(projectId, FILE, () => ({ aiChecks: [] }))
  ]);
  const { files, issues } = manuscript;
  const citations = auditCitations(files, papers, { issues });
  const terminology = terminologyCheck(files, workflow);
  const compileTasks = (await readHubJson(projectId, 'tasks.json', () => ({ tasks: [] }))).tasks || [];
  const compileIssues = compileTasks.filter((task) => task.kind === 'compile' && task.status === 'failed').map((task) => ({ id: task.id, title: task.title, error: task.error, log: task.log }));
  const aiChecks = runs.map((run) => ({ id: run.id, status: run.status, validation: run.validation || null, output: run.output || null, updatedAt: run.updatedAt }));
  return {
    checkedAt: now(),
    overall: matrix.ok && citations.ok && terminology.ok && compileIssues.length === 0 ? 'pass' : 'needs-review',
    claims: matrix,
    citations,
    terminology,
    compile: { ok: compileIssues.length === 0, issues: compileIssues },
    ai: { status: aiChecks.length || stored.aiChecks?.length ? 'available' : 'not-run', checks: [...aiChecks, ...(stored.aiChecks || [])].slice(0, 20) },
    manuscript: { fileCount: files.length, textBytes: files.reduce((sum, file) => sum + file.content.length, 0) }
  };
}

export async function recordAiQualityCheck(projectId, result, actor = 'human') {
  const stored = await readHubJson(projectId, FILE, () => ({ aiChecks: [] }));
  const check = { id: `ai-check-${Date.now()}`, actor, result, checkedAt: now() };
  stored.aiChecks = [check, ...(stored.aiChecks || [])].slice(0, 20);
  stored.updatedAt = now();
  await writeHubJson(projectId, FILE, stored);
  return check;
}

