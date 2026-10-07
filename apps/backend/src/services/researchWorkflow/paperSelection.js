import crypto from 'node:crypto';
import { getEvidenceLedger, upsertEvidence } from '../evidenceLedger/index.js';
import { validatePaperMetadata } from '../researchResearch/paperCandidates.js';
import { ResearchWorkflowError } from './errors.js';
import { getStageData } from './queries.js';
import { applyStageUpdate } from './stateMachine.js';
import { createStageTask } from './stageTask.js';

function invalid(message) {
  throw new ResearchWorkflowError(400, 'INVALID_PAPER_SELECTION', message);
}

function reviewText(value, field) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2000) invalid(`${field} must be a string of at most 2000 characters.`);
  return value.trim();
}

function paperEvidenceId(paper) {
  const identity = paper?.doi || paper?.url || paper?.id || paper?.title || 'paper';
  return `paper-${crypto.createHash('sha1').update(String(identity)).digest('hex').slice(0, 20)}`;
}

async function confirmPaperEvidence(projectId, paper, actor) {
  const evidenceId = paperEvidenceId(paper);
  await upsertEvidence(projectId, {
    id: evidenceId, kind: 'paper', title: paper.title || 'Untitled paper',
    summary: paper.abstract || 'Paper metadata was selected by a human and requires source-level review.',
    sourceUrl: paper.url || null, acquiredAt: paper.retrievedAt || new Date().toISOString(),
    verificationStatus: 'human-confirmed', version: paper.metadataUpdatedAt || paper.retrievedAt || 'retrieved',
    metadata: {
      paperId: paper.id, doi: paper.doi, authors: paper.authors, year: paper.year,
      venue: paper.venue, publicationType: paper.publicationType, source: paper.source,
      sourceRecords: paper.sourceRecords || [], metadataValidation: validatePaperMetadata(paper)
    }
  }, { actor });
  return evidenceId;
}

// Called under the workflow command lock, after version and replay checks.
export async function applyPaperSelection(projectId, workflow, { paperIds = [], reviews, actor, note }) {
  if (actor !== 'human') throw new ResearchWorkflowError(403, 'HUMAN_INPUT_REQUIRED', 'Only a human may save paper selection.');
  if (!Array.isArray(paperIds) || paperIds.some((id) => typeof id !== 'string' || !id) || new Set(paperIds).size !== paperIds.length) invalid('paperIds must contain unique nonempty strings.');
  const search = getStageData(workflow, 'search');
  const previous = getStageData(workflow, 'selection');
  const evaluations = search.evaluations || [];
  const candidates = new Map(evaluations.map((item) => [String(item.id), item]));
  const selected = new Set(paperIds);
  const blocked = paperIds.filter((id) => candidates.get(id)?.decision !== 'accept');
  if (blocked.length) throw new ResearchWorkflowError(409, 'QUALITY_GATE', 'Only papers accepted by the server-side quality gate can be selected.', { blockedPaperIds: blocked });
  if (reviews !== undefined && (!Array.isArray(reviews) || reviews.length > candidates.size)) invalid('reviews must be an array of candidate decisions.');
  const explicit = new Map();
  for (const item of reviews || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['paperId', 'decision', 'reason', 'criterion'].includes(key))) invalid('Invalid review fields.');
    if (!candidates.has(item.paperId) || explicit.has(item.paperId)) invalid('Each review must name one unique search candidate.');
    if (!['include', 'exclude', 'undecided'].includes(item.decision) || (item.decision === 'include') !== selected.has(item.paperId)) invalid('Review decisions must agree with paperIds.');
    explicit.set(item.paperId, { paperId: item.paperId, decision: item.decision, reason: reviewText(item.reason, 'reason'), criterion: reviewText(item.criterion, 'criterion') });
  }
  const savedReviews = new Map((previous.reviews || []).map((item) => [item.paperId, item]));
  const history = [...(previous.reviewHistory || [])];
  const previousIds = new Set(previous.selectedPaperIds || []);
  const now = new Date().toISOString();
  for (const [paperId, evaluation] of candidates) {
    const old = savedReviews.get(paperId);
    let next = explicit.get(paperId);
    if (!next && (selected.has(paperId) !== previousIds.has(paperId) || (selected.has(paperId) && !old))) {
      next = { paperId, decision: selected.has(paperId) ? 'include' : 'undecided', reason: '', criterion: '' };
    }
    if (!next || (old && ['decision', 'reason', 'criterion'].every((key) => old[key] === next[key]))) continue;
    const record = { ...next, actor: 'human', at: now, workflowVersion: workflow.version };
    savedReviews.set(paperId, record);
    history.push({ ...record, paper: structuredClone(evaluation.candidate), context: {
      queries: search.queries || [], policy: search.policy || {},
      inclusionCriteria: search.aiSearchStrategy?.inclusionCriteria || [],
      exclusionCriteria: search.aiSearchStrategy?.exclusionCriteria || [],
      humanInstructions: workflow.humanInstructions?.selection || ''
    } });
  }
  const selectedPapers = evaluations.filter((item) => selected.has(String(item.id))).map((item) => item.candidate);
  const evidenceIds = selectedPapers.map(paperEvidenceId);
  const data = {
    selectedPaperIds: paperIds, selectedPapers: selectedPapers.map((paper, index) => ({ ...paper, evidenceId: evidenceIds[index] })),
    evidenceIds, policy: search.policy || {}, reviews: [...savedReviews.values()], reviewHistory: history,
    task: createStageTask({ stage: 'selection', input: { requestedPaperIds: paperIds, qualityPolicy: search.policy || {}, reviews: [...savedReviews.values()] }, output: { selectedPaperIds: paperIds, evidenceIds }, adapters: ['quality-gate', 'evidence-ledger', 'human-input'] })
  };
  // Validate stage, completion and note before any cross-file side effect.
  applyStageUpdate(workflow, { stageId: 'selection', data, status: 'in_progress', actor, note });
  const existing = new Set((await getEvidenceLedger(projectId)).entries.map((entry) => entry.id));
  for (const paper of selectedPapers) {
    if (!existing.has(paperEvidenceId(paper))) await confirmPaperEvidence(projectId, paper, actor);
  }
  // Evidence is retained on withdrawal: other claims may already reference it.
  // Disk failures between ledger and workflow writes still require recovery.
  return workflow;
}
