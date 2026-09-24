import crypto from 'node:crypto';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

/** Build the common lifecycle record stored alongside every stage result. */
export function createStageTask({
  stage,
  input = {},
  output = null,
  validation = { ok: true, errors: [], warnings: [] },
  harness = null,
  adapters = [],
  error = null,
  createdAt = now()
} = {}) {
  const valid = validation?.ok !== false && !error;
  return {
    id: `stage-task-${crypto.randomUUID()}`,
    stage,
    status: valid ? 'awaiting_approval' : 'failed',
    input: clone(input),
    output: clone(output),
    validation: clone({
      ok: validation?.ok !== false,
      errors: Array.isArray(validation?.errors) ? validation.errors : [],
      warnings: Array.isArray(validation?.warnings) ? validation.warnings : []
    }),
    harness: harness ? clone({
      runId: harness.runId || null,
      adapter: harness.adapter || harness.runtime || null,
      status: harness.status || (harness.ok ? 'completed' : 'failed'),
      fallback: harness.fallback === true
    }) : null,
    adapters: [...new Set((Array.isArray(adapters) ? adapters : []).map(String).filter(Boolean))],
    humanDecision: null,
    error: error ? { code: error.code || 'STAGE_TASK_FAILED', message: error.message || String(error) } : null,
    createdAt,
    updatedAt: createdAt
  };
}

export function markStageTaskDecision(task, { decision, actor = 'human', note = '', at = now() } = {}) {
  if (!task || typeof task !== 'object') return task;
  return {
    ...clone(task),
    status: decision === 'approve' || decision === 'skip' ? 'approved' : decision === 'reject' ? 'rejected' : task.status,
    humanDecision: { decision, actor, note: String(note || '').trim(), at },
    updatedAt: at
  };
}
