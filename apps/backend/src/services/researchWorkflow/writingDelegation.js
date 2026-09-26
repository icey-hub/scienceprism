import { createHash } from 'node:crypto';
import { createHarnessRun, getHarnessRun, listHarnessRuns, runHarnessRequest } from '../harnessRuntime/index.js';
import { runResearchStage } from '../researchResearch/harnessAdapter.js';
import { ResearchWorkflowError } from './errors.js';

let activeProjectId = null;
const REVIEW_TASKS = Object.freeze([
  { id: 'claim-evidence-audit', label: '论断与证据审查', instruction: 'Identify claims that lack confirmed Evidence IDs, cite mismatched Evidence, or treat pending results as established. Give concrete findings only.' },
  { id: 'method-consistency-review', label: '方法与结论审查', instruction: 'Identify inconsistencies between the proposed method, experiment artifacts, metrics, limitations, and intended conclusions. Give concrete findings only.' }
]);

function fingerprint({ input, humanInstructions, adapter, model }) {
  return createHash('sha256').update(JSON.stringify({ input, humanInstructions, adapter, model })).digest('hex');
}

function reviewPrompt(task, input, humanInstructions) {
  const materials = JSON.stringify({
    direction: input.direction,
    papers: (input.papers || []).map(({ id, title, evidenceId }) => ({ id, title, evidenceId })),
    ideas: input.ideas,
    method: input.method,
    experiment: input.experiment,
    evidenceLedger: input.evidenceLedger
  }).slice(0, 18000);
  return [
    `You are an independent read-only paper reviewer. Task: ${task.label}.`,
    task.instruction,
    'Write a concise review with specific evidence IDs where possible. Treat every model judgment as an unverified review opinion. Do not approve a stage, modify files, or claim to have verified a source or result.',
    `Research materials: ${materials}`,
    humanInstructions ? `Researcher instructions: ${String(humanInstructions).slice(0, 2000)}` : ''
  ].filter(Boolean).join('\n\n');
}

function childSummary(run, task) {
  return {
    runId: run.id,
    task: task.id,
    label: task.label,
    status: run.status,
    reply: String(run.reply || '').slice(0, 4000),
    tokenUsage: run.tokenUsage || null,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    error: run.error || null
  };
}

function failedResult(parent, children, task, message) {
  const code = task.id === 'coordinator' ? 'COORDINATOR_FAILED' : 'CHILD_REVIEW_FAILED';
  return {
    ok: false,
    runId: parent.id,
    output: null,
    validation: { ok: false, errors: [{ path: `delegation.${task.id}`, code, message }], warnings: [] },
    error: { code, message },
    delegation: { mode: 'multi-agent', parentRunId: parent.id, children, coordinatorRunIds: [] }
  };
}

/** Two independent read-only reviews followed by the existing validated writing producer. */
export async function runWritingDelegation({ projectId, input, humanInstructions, llmConfig, adapter, fakeResponse, fakeReviewResponses } = {}) {
  if (activeProjectId) {
    throw new ResearchWorkflowError(409, 'DELEGATION_IN_PROGRESS', 'A writing delegation is already using the shared model gateway.');
  }
  activeProjectId = projectId;
  try {
    const delegationKey = fingerprint({ input, humanInstructions, adapter, model: llmConfig?.model });
    const recent = await listHarnessRuns(projectId, { stage: 'writing', limit: 100 });
    let parent = recent.find((run) => run.request?.delegationKey === delegationKey
      && run.request?.delegationMode === 'writing-review'
      && (run.status === 'created' || (run.status === 'failed' && run.attempt <= run.limits.retryLimit)));
    if (!parent) {
      parent = await createHarnessRun(projectId, {
        stage: 'writing', task: 'research:writing', role: 'research-stage-assistant',
        capabilities: ['project.read'], adapter, llmConfig, input,
        delegationKey, delegationMode: 'writing-review'
      });
    }

    const children = [];
    for (const task of REVIEW_TASKS) {
      const previous = await listHarnessRuns(projectId, { parentRunId: parent.id, limit: 100 });
      let child = previous.find((run) => run.delegationTask === task.id && run.status === 'completed' && run.reply?.trim());
      if (!child) {
        try {
          const result = await runHarnessRequest({
            projectId, stage: 'writing', task: `review:${task.id}`, role: 'paper-reviewer',
            parentRunId: parent.id, delegationTask: task.id, capabilities: ['project.read'],
            adapter, llmConfig, prompt: reviewPrompt(task, input, humanInstructions),
            ...(adapter === 'fake' ? { fakeResponse: fakeReviewResponses?.[task.id] ?? `${task.label}: no finding in fake adapter.` } : {})
          });
          child = await getHarnessRun(projectId, result.runId);
        } catch (error) {
          return failedResult(parent, children, task, error instanceof Error ? error.message : String(error));
        }
      }
      children.push(childSummary(child, task));
      if (child.status !== 'completed' || !child.reply?.trim()) {
        return failedResult(parent, children, task, child.error?.message || 'The reviewer returned an empty or failed response.');
      }
    }

    const reviews = children.map(({ runId, task, label, reply }) => ({ runId, task, label, reviewOpinion: reply }));
    let coordinator;
    try {
      coordinator = await runResearchStage({
        stage: 'writing', projectId, input, humanInstructions, llmConfig, adapter, fakeResponse,
        existingRunId: parent.id,
        context: { delegatedReviews: reviews, note: 'These are independent review opinions, not verified Evidence.' }
      });
    } catch (error) {
      return failedResult(parent, children, { id: 'coordinator' }, error instanceof Error ? error.message : String(error));
    }
    const coordinatorRun = coordinator.runId ? await getHarnessRun(projectId, coordinator.runId) : null;
    return {
      ...coordinator,
      delegation: {
        mode: 'multi-agent', parentRunId: parent.id, children,
        coordinatorRunIds: (coordinator.attempts || []).map((attempt) => attempt.runId).filter(Boolean),
        coordinator: coordinatorRun ? { runId: coordinatorRun.id, status: coordinatorRun.status, tokenUsage: coordinatorRun.tokenUsage || null, createdAt: coordinatorRun.createdAt, finishedAt: coordinatorRun.finishedAt } : null
      }
    };
  } finally {
    activeProjectId = null;
  }
}
