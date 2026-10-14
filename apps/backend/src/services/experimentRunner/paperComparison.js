import { createHash } from 'node:crypto';
import { getPaper } from '../projectHub/paperLibrary.js';
import { getResearchWorkflow } from '../researchWorkflow/index.js';
import { sourceHash } from '../researchAutomation/handoff.js';
import { ExperimentRunnerError } from './errors.js';

const gaps = ['none', 'data-coverage', 'missing-control', 'generalization', 'missing-report', 'replication-failed'];
const rowFields = ['metricName', 'reportedValue', 'unit', 'referenceLocation', 'reportedText', 'causeHypothesis', 'nextStep', 'gapType', 'tolerance'];
const fail = (code, message, status = 400) => { throw new ExperimentRunnerError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit, required = false) => typeof value === 'string' && value.isWellFormed() && value.length <= limit && (!required || value.trim());
const number = value => value === null || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e100;

export function validatePaperComparison(input) {
  if (!plain(input) || Object.keys(input).some(key => !['expectedRevision', 'paperId', 'rows'].includes(key))
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER
    || !text(input.paperId, 200, true) || !Array.isArray(input.rows) || input.rows.length > 50) {
    fail('PAPER_COMPARISON_INPUT_INVALID', 'Provide the current comparison revision, one project paper and at most 50 rows.');
  }
  const rows = input.rows.map(row => {
    if (!plain(row) || Object.keys(row).length !== rowFields.length || Object.keys(row).some(key => !rowFields.includes(key))
      || !text(row.metricName, 200, true) || !text(row.unit, 100) || !text(row.referenceLocation, 1000)
      || ['reportedText', 'causeHypothesis', 'nextStep'].some(key => !text(row[key], 4000)) || !gaps.includes(row.gapType)
      || !number(row.reportedValue) || !number(row.tolerance) || row.tolerance !== null && row.tolerance < 0
      || row.reportedValue !== null && (!row.referenceLocation.trim() || !row.reportedText.trim())) {
      fail('PAPER_COMPARISON_ROW_INVALID', 'Comparison rows accept bounded source text, finite numbers and a nonnegative optional tolerance; actual results are server-owned.');
    }
    return { ...row, metricName: row.metricName.trim(), unit: row.unit.trim() };
  });
  if (new Set(rows.map(row => row.metricName)).size !== rows.length) fail('PAPER_COMPARISON_METRIC_DUPLICATE', 'Each comparison row must identify one unique Run metric.');
  return { expectedRevision: input.expectedRevision, paperId: input.paperId.trim(), rows };
}

function snapshot(paper, fixed = false) {
  if (!text(paper?.id, 200, true) || !text(paper?.title, 4000, true)) fail('PAPER_COMPARISON_SOURCE_INVALID', 'The selected project paper has no valid fixed metadata.', 409);
  const metadata = { id: paper.id, title: paper.title };
  for (const key of ['authors', 'year', 'doi', 'url', 'source', 'sourceRecords', 'evidenceId']) if (paper[key] !== undefined && paper[key] !== null) metadata[key] = paper[key];
  const sha256 = fixed && /^[a-f0-9]{64}$/.test(paper.sha256) ? paper.sha256 : sourceHash(metadata);
  return { id: paper.id, title: paper.title, ...Object.fromEntries(['doi', 'url', 'year'].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])), sha256 };
}

export async function resolvePaperComparisonSource(projectId, run, paperId) {
  const fixed = run.manifest?.replication?.paper;
  if (fixed) {
    if (fixed.id !== paperId) fail('PAPER_COMPARISON_SOURCE_MISMATCH', 'Preserve the original Run-bound paper when comparing its results.', 409);
    return { paper: snapshot(fixed, true), paperBinding: 'run-bound' };
  }
  let paper;
  try { paper = await getPaper(projectId, paperId); }
  catch (error) { if (error.message !== 'Paper not found.') throw error; }
  if (!paper) {
    let workflow;
    try { workflow = await getResearchWorkflow(projectId); }
    catch (error) { if (error.code !== 'WORKFLOW_NOT_FOUND') throw error; }
    const selected = workflow?.stages?.find(stage => stage.id === 'selection')?.data?.selectedPapers;
    const matches = Array.isArray(selected) ? selected.filter(item => item?.id === paperId) : [];
    if (matches.length > 1) fail('PAPER_COMPARISON_SOURCE_AMBIGUOUS', 'The project has multiple selected records for this paper.', 409);
    paper = matches[0];
  }
  if (!paper) fail('PAPER_COMPARISON_SOURCE_NOT_FOUND', 'Choose an explicit paper in this project library or current selected papers.', 404);
  return { paper: snapshot(paper), paperBinding: 'analysis-linked' };
}

export function buildPaperComparison(run, input, source, { actor, sourceRunId } = {}) {
  const rows = input.rows.map(row => {
    const matches = (run.metrics || []).filter(metric => metric.name === row.metricName);
    const metric = matches.length === 1 ? matches[0] : null;
    const actualValue = typeof metric?.value === 'number' && Number.isFinite(metric.value) ? metric.value : null;
    let status = run.status === 'failed' ? 'run-failed' : run.status !== 'completed' ? 'run-incomplete'
      : row.reportedValue === null ? 'missing-report' : actualValue === null ? 'missing-result' : 'unassessed';
    let difference = null;
    if (status === 'unassessed' && (!metric.unit || metric.unit === row.unit)) {
      difference = actualValue - row.reportedValue;
      if (Number.isFinite(difference) && row.tolerance !== null) status = Math.abs(difference) <= row.tolerance ? 'match' : 'different';
      else if (!Number.isFinite(difference)) difference = null;
    }
    return { ...row, id: `comparison-row-${createHash('sha256').update(`${run.id}:${source.paper.id}:${row.metricName}`).digest('hex').slice(0, 20)}`,
      actualValue, difference, status, hypothesisStatus: 'unverified' };
  });
  return { revision: input.expectedRevision + 1, runId: run.id, ...source,
    source: ['human', 'researcher'].includes(actor) ? 'human' : 'ai', ...(sourceRunId ? { sourceRunId } : {}), updatedAt: new Date().toISOString(), runStatus: run.status, rows };
}

export function projectPaperComparison(run) {
  const saved = run.paperComparison;
  if (!saved) return null;
  const projected = buildPaperComparison(run, { expectedRevision: saved.revision - 1,
    rows: saved.rows.map(row => Object.fromEntries(rowFields.map(key => [key, row[key]]))) }, { paper: saved.paper });
  return { ...saved, runStatus: projected.runStatus, rows: projected.rows };
}
