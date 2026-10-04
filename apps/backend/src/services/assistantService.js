import { createHash } from 'node:crypto';
import { createHarnessRun, listHarnessRuns, startHarnessRun } from './harnessRuntime/index.js';
import { HarnessRuntimeError } from './harnessRuntime/errors.js';
import { resolveAgentRuntime } from './agentRuntime.js';

const starts = new Map();
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

/** The editor owns task intent; the server owns capabilities and execution. */
export async function startAssistantRun(projectId, input = {}, overrides = {}) {
  const requestId = text(input.requestId, 100);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
    throw new HarnessRuntimeError(400, 'INVALID_REQUEST_ID', 'A task request id is required.');
  }
  const permission = input.permission === 'read' ? 'read' : 'edit';
  const request = {
    source: 'editor', requestId, permission,
    task: text(input.task, 80) || 'custom',
    prompt: text(input.prompt, 16000),
    activePath: text(input.activePath, 500),
    selection: text(input.selection, 40000),
    compileLog: text(input.compileLog, 24000),
    history: Array.isArray(input.history) ? input.history
      .filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string')
      .slice(-8).map((item) => ({ role: item.role, content: text(item.content, 4000) })) : [],
    documentVersions: Array.isArray(input.documentVersions) ? input.documentVersions.map((item) => ({
      path: text(item?.path, 500), exists: item?.exists !== false, sha256: item?.sha256 ?? null
    })) : [],
    llmConfig: {
      endpoint: text(input.llmConfig?.endpoint, 2000),
      model: text(input.llmConfig?.model, 200),
      runtime: resolveAgentRuntime(input.llmConfig)
    }
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const previous = starts.get(projectId) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const [repeated] = await listHarnessRuns(projectId, { source: 'editor', requestId, limit: 1 });
    if (repeated) {
      if (repeated.request?.fingerprint && repeated.request.fingerprint !== fingerprint) {
        throw new HarnessRuntimeError(409, 'REQUEST_ID_CONFLICT', 'This request id already belongs to a different task.', { runId: repeated.id });
      }
      return repeated;
    }
    for (const status of ['created', 'running', 'paused']) {
      const [active] = await listHarnessRuns(projectId, { source: 'editor', status, limit: 1 });
      if (active) throw new HarnessRuntimeError(409, 'ASSISTANT_BUSY', 'Finish or stop the current task first.', { runId: active.id });
    }
    const run = await createHarnessRun(projectId, {
      ...request, fingerprint,
      llmConfig: { ...request.llmConfig, apiKey: input.llmConfig?.apiKey },
      adapter: request.llmConfig.runtime === 'deepseek-harness' ? 'deepseek' : 'legacy',
      role: 'project-agent',
      capabilities: permission === 'read' ? ['project.read'] : ['project.read', 'patch.propose'],
      fallback: true,
      ...overrides
    });
    return startHarnessRun(projectId, run.id, { wait: false });
  });
  starts.set(projectId, pending);
  try { return await pending; }
  finally { if (starts.get(projectId) === pending) starts.delete(projectId); }
}
