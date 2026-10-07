import { createHash } from 'node:crypto';
import { createHarnessRun, listHarnessRuns, readProjectConstraints, startHarnessRun } from './harnessRuntime/index.js';
import { getProjectRoot } from './projectService.js';
import { applyProjectConstraintPolicy, resolveCapabilityPolicy } from './harnessRuntime/capabilities.js';
import { resolveRoleCapabilities } from './agentRoles/index.js';
import { HarnessRuntimeError } from './harnessRuntime/errors.js';
import { resolveAgentRuntime } from './agentRuntime.js';
import { listSkillCatalog } from './skillCatalog.js';

const starts = new Map();
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

/** Discovery uses the same project constraints and role ceiling as execution. */
export async function listAssistantSkills(projectId) {
  const projectRoot = await getProjectRoot(projectId);
  const constraints = await readProjectConstraints(projectRoot);
  const policy = applyProjectConstraintPolicy(resolveCapabilityPolicy({
    requested: ['project.read'], configured: constraints.capabilities
  }), constraints);
  const { granted } = resolveRoleCapabilities('project-agent', policy);
  return listSkillCatalog({ projectRoot, capabilityPolicy: { ...policy, granted } });
}

/** The editor owns task intent; the server owns capabilities and execution. */
export async function startAssistantRun(projectId, input = {}, overrides = {}) {
  const requestId = text(input.requestId, 100);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
    throw new HarnessRuntimeError(400, 'INVALID_REQUEST_ID', 'A task request id is required.');
  }
  if (input.skillNames !== undefined && (!Array.isArray(input.skillNames) || input.skillNames.length > 20
    || input.skillNames.some((name) => typeof name !== 'string' || name.length > 100 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name))
    || new Set(input.skillNames).size !== input.skillNames.length)) {
    throw new HarnessRuntimeError(400, 'INVALID_SKILL_SELECTION', 'Select up to 20 distinct Skill names.');
  }
  const permission = input.permission === 'read' ? 'read' : 'edit';
  const request = {
    source: 'editor', requestId, permission,
    ...(input.skillNames === undefined ? {} : { skillNames: [...input.skillNames].sort() }),
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
    let selectedSkills = [];
    if (request.skillNames?.length) {
      const { skills } = await listAssistantSkills(projectId);
      selectedSkills = request.skillNames.map((name) => {
        const skill = skills.find((item) => item.name === name);
        if (!skill?.available) throw new HarnessRuntimeError(400, 'SKILL_UNAVAILABLE', 'A selected Skill is unavailable.', { name, reason: skill?.reason || 'NOT_FOUND' });
        const { description, stages, source, relativePath } = skill;
        return { name, description, stages, source, relativePath };
      });
    }
    const run = await createHarnessRun(projectId, {
      ...request, fingerprint,
      ...(request.skillNames === undefined ? {} : {
        researchSkills: request.skillNames,
        researchSkillMetadata: selectedSkills
      }),
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
