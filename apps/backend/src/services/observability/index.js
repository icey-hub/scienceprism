import { getClaimEvidenceMatrix } from '../evidenceLedger/index.js';
import { listExperimentRuns } from '../experimentRunner/index.js';
import { listHarnessRuns } from '../harnessRuntime/index.js';
import { getProjectFeatureFlags } from '../featureFlags.js';

function timeValue(value) {
  const result = Date.parse(value || '');
  return Number.isFinite(result) ? result : null;
}

function durationMs(startedAt, finishedAt) {
  const start = timeValue(startedAt);
  const end = timeValue(finishedAt);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== 'object') return { input: 0, output: 0, total: 0 };
  const input = number(value.input ?? value.inputTokens ?? value.promptTokens ?? value.prompt_tokens);
  const output = number(value.output ?? value.outputTokens ?? value.completionTokens ?? value.completion_tokens);
  const total = number(value.total ?? value.totalTokens ?? value.total_tokens) || input + output;
  return { input, output, total };
}

function summarizeHarnessRun(run) {
  const tokens = normalizeTokenUsage(run.tokenUsage);
  return {
    type: 'harness',
    runId: run.id,
    stage: run.stage,
    task: run.task,
    status: run.status,
    adapter: run.adapter,
    durationMs: durationMs(run.startedAt, run.finishedAt),
    tokens,
    tokenUsage: run.tokenUsage || null,
    contextHash: run.contextHash || null,
    contextManifest: run.contextManifest || null,
    eventCount: Array.isArray(run.events) ? run.events.length : 0,
    humanDecision: run.humanDecision || null,
    error: run.error || null,
    updatedAt: run.updatedAt
  };
}

function summarizeExperimentRun(run) {
  return {
    type: 'experiment',
    runId: run.id,
    stage: 'experiment',
    task: run.planId,
    status: run.status,
    adapter: run.manifest?.command?.adapter || null,
    durationMs: durationMs(run.execution?.startedAt || run.startedAt, run.execution?.finishedAt || (['completed', 'failed', 'cancelled'].includes(run.status) ? run.updatedAt : null)),
    tokens: { input: 0, output: 0, total: 0 },
    tokenUsage: null,
    contextHash: null,
    contextManifest: null,
    eventCount: 0,
    humanDecision: run.approval ? { status: run.approval.decision === 'approve' ? 'accepted' : 'rejected', ...run.approval } : null,
    error: run.error || null,
    updatedAt: run.updatedAt
  };
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function summarizeRuns(runs) {
  const terminal = runs.filter((run) => ['completed', 'failed', 'cancelled'].includes(run.status));
  const durations = terminal.map((run) => run.durationMs).filter((value) => value !== null);
  const tokens = terminal.reduce((sum, run) => ({
    input: sum.input + run.tokens.input,
    output: sum.output + run.tokens.output,
    total: sum.total + run.tokens.total
  }), { input: 0, output: 0, total: 0 });
  const failed = terminal.filter((run) => run.status === 'failed').length;
  const decisions = runs.map((run) => run.humanDecision?.status).filter((status) => ['accepted', 'rejected'].includes(status));
  const rejected = decisions.filter((status) => status === 'rejected').length;
  return {
    total: runs.length,
    terminal: terminal.length,
    completed: terminal.filter((run) => run.status === 'completed').length,
    failed,
    cancelled: terminal.filter((run) => run.status === 'cancelled').length,
    failureRate: terminal.length ? failed / terminal.length : 0,
    averageDurationMs: average(durations),
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    tokens,
    humanDecisions: decisions.length,
    humanRejected: rejected,
    humanRejectionRate: decisions.length ? rejected / decisions.length : 0
  };
}

export async function getProjectObservability(projectId, { limit = 50 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const [harnessRuns, experimentRuns, matrix, featureFlags] = await Promise.all([
    // Aggregates use the complete retained Run history; `limit` only bounds recentRuns.
    listHarnessRuns(projectId, { limit: 100 }),
    listExperimentRuns(projectId, { limit: 500 }),
    getClaimEvidenceMatrix(projectId),
    getProjectFeatureFlags(projectId)
  ]);
  const runs = [
    ...harnessRuns.map(summarizeHarnessRun),
    ...experimentRuns.map(summarizeExperimentRun)
  ].sort((left, right) => (timeValue(right.updatedAt) || 0) - (timeValue(left.updatedAt) || 0));
  const harness = runs.filter((run) => run.type === 'harness');
  const experiments = runs.filter((run) => run.type === 'experiment');
  const evidenceTotal = Number(matrix.totalClaims) || 0;
  const evidenceMissing = Number(matrix.unsupportedClaims) || 0;
  return {
    generatedAt: new Date().toISOString(),
    projectId,
    featureFlags,
    runs: summarizeRuns(runs),
    harness: summarizeRuns(harness),
    experiments: summarizeRuns(experiments),
    evidence: {
      totalClaims: evidenceTotal,
      supportedClaims: Number(matrix.supportedClaims) || 0,
      needsVerificationClaims: Number(matrix.needsVerificationClaims) || 0,
      unsupportedClaims: evidenceMissing,
      missingEvidenceRate: evidenceTotal ? evidenceMissing / evidenceTotal : 0,
      missingEvidenceIds: matrix.missingEvidenceIds || [],
      staleEvidenceIds: matrix.staleEvidenceIds || []
    },
    recentRuns: runs.slice(0, boundedLimit)
  };
}
