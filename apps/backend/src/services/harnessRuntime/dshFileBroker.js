import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isPathAllowed } from './capabilities.js';
import { HarnessRuntimeError } from './errors.js';
import { sourceForProjectedSkillRead } from '../skillRuntime/projection.js';

export const DSH_FILE_TOOLS = Object.freeze({ project_read_file: 'project.read', project_propose_patch: 'patch.propose' });
const MAX_BYTES = 1_048_576;
const fail = (code, message) => new HarnessRuntimeError(403, code, message);
const digest = value => createHash('sha256').update(value).digest('hex');

function policySnapshot(value) {
  if (!value || !['projectId', 'runId', 'role', 'task'].every(key => typeof value[key] === 'string' && value[key])
    || !['auto', 'manual'].includes(value.mode) || typeof value.active !== 'boolean'
    || !(typeof value.version === 'string' && value.version || typeof value.version === 'number' && Number.isFinite(value.version))) {
    throw fail('DSH_POLICY_UNAVAILABLE', 'The current Run policy is invalid.');
  }
  const capabilities = {};
  for (const key of ['granted', 'allowedPaths', 'networkAllowlist']) {
    if (!Array.isArray(value.capabilities?.[key]) || value.capabilities[key].some(item => typeof item !== 'string')) {
      throw fail('DSH_POLICY_UNAVAILABLE', 'The current Run capability policy is invalid.');
    }
    capabilities[key] = Object.freeze([...value.capabilities[key]]);
  }
  return Object.freeze(Object.fromEntries([...['projectId', 'runId', 'role', 'task', 'mode', 'active', 'version'].map(key => [key, value[key]]), ['capabilities', Object.freeze(capabilities)]]));
}

function parameters(tool, input, skillDocuments) {
  if (!Object.hasOwn(DSH_FILE_TOOLS, tool)) throw fail('DSH_TOOL_NOT_BOUND', 'This tool is not bound to the project Run.');
  const allowed = tool === 'project_read_file' ? ['path', 'fromLine', 'toLine'] : ['path', 'content', 'expectedSha256'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fail('DSH_ARGUMENTS_INVALID', 'The tool arguments are invalid.');
  const value = { ...input };
  if (typeof value.path !== 'string' || !value.path || value.path.length > 1024 || /[\\\x00-\x1f]/.test(value.path)
    || path.posix.isAbsolute(value.path) || /^[A-Za-z]:/.test(value.path)
    || value.path.split('/').some(part => !part || ['.', '..', '.codex'].includes(part))) throw fail('PATH_DENIED', 'A normalized relative project file path is required.');
  if (value.path.split('/').includes('.dsh') && !(tool === 'project_read_file' && skillDocuments.has(value.path))) throw fail('PATH_DENIED', 'Only selected, immutable Skill documents may be read from the runtime directory.');
  if (tool === 'project_read_file') {
    value.fromLine ??= 1;
    value.toLine ??= value.fromLine + 999;
    if (!Number.isSafeInteger(value.fromLine) || !Number.isSafeInteger(value.toLine) || value.fromLine < 1 || value.toLine < value.fromLine || value.toLine - value.fromLine >= 1000) throw fail('DSH_ARGUMENTS_INVALID', 'Read at most 1000 numbered lines.');
  } else if (typeof value.content !== 'string' || Buffer.byteLength(value.content) > MAX_BYTES
    || !(value.expectedSha256 === null || typeof value.expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.expectedSha256))) {
    throw fail('DSH_ARGUMENTS_INVALID', 'A bounded text proposal and its expected file hash are required.');
  }
  return Object.freeze(value);
}

function resolveFile(root, relative, allowMissing) {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (reason) { if (allowMissing && index === parts.length - 1 && reason.code === 'ENOENT') return { path: current, exists: false }; throw fail('DSH_FILE_UNAVAILABLE', 'The project file or its parent directory is unavailable.'); }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw fail('PATH_DENIED', 'Only regular files without symbolic or hard links are supported.');
  }
  return { path: current, exists: true };
}

function readFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw fail('DSH_FILE_UNAVAILABLE', 'The project file is not a bounded regular file.');
    const content = fs.readFileSync(fd);
    if (content.length > MAX_BYTES || content.includes(0)) throw fail('DSH_FILE_UNAVAILABLE', 'The project file is not bounded text.');
    return content;
  } finally { fs.closeSync(fd); }
}

/** Per-Run file authority, not a scheduler or another persisted Run owner.
 * The caller keeps the instance/private IPC outside the model workspace. Both
 * callbacks may be asynchronous and must use the existing Run repository.
 */
export async function createDshFileBroker({ workspace, readPolicy, onDecision, signal, skillProjection, emit = () => {} }) {
  if (typeof readPolicy !== 'function' || typeof onDecision !== 'function') throw fail('DSH_POLICY_UNAVAILABLE', 'Current policy and persisted decisions are required.');
  const root = fs.realpathSync(workspace);
  if (!fs.statSync(root).isDirectory()) throw fail('PATH_DENIED', 'A temporary workspace directory is required.');
  const ceiling = policySnapshot(await readPolicy());
  const projection = { documents: (skillProjection?.documents || []).map(document => Object.freeze({ ...document })) };
  const skillDocuments = new Map();
  for (const document of projection.documents) {
    if (typeof document.projectionPath !== 'string' || !/^\.dsh\/skills\/[a-z][a-z0-9-]*\/.+\.md$/.test(document.projectionPath)
      || document.projectionPath.split('/').some(part => !part || ['.', '..', '.codex'].includes(part))
      || /[\\\x00-\x1f]/.test(document.projectionPath) || !/^[a-f0-9]{64}$/.test(document.sha256)
      || !Number.isSafeInteger(document.bytes) || document.bytes < 0 || document.bytes > MAX_BYTES || skillDocuments.has(document.projectionPath)) throw fail('DSH_SKILL_PROJECTION_INVALID', 'The selected Skill document manifest is invalid.');
    skillDocuments.set(document.projectionPath, document);
  }
  const closed = new AbortController();
  let pending = Promise.resolve();
  const check = (current, tool, args) => {
    if (signal?.aborted || closed.signal.aborted) throw fail('DSH_CANCELLED', 'The project tool call was cancelled.');
    if (!current.active || !ceiling.active) throw fail('DSH_RUN_INACTIVE', 'The owning Run is inactive.');
    if (['projectId', 'runId', 'role', 'task'].some(key => current[key] !== ceiling[key])) throw fail('DSH_OWNER_CHANGED', 'The tool no longer belongs to its bound Run, role and task.');
    if (current.mode !== 'auto' || ceiling.mode !== 'auto') throw fail('DSH_APPROVAL_UNAVAILABLE', 'Manual tools require a project approval channel.');
    const capability = DSH_FILE_TOOLS[tool];
    for (const policy of [ceiling, current]) {
      if (!policy.capabilities.granted.includes(capability)) throw fail('CAPABILITY_DENIED', 'The required capability is not granted.');
      if (!(tool === 'project_read_file' && skillDocuments.has(args.path)) && !isPathAllowed(args.path, policy.capabilities)) throw fail('PATH_DENIED', 'The project file is outside the allowed paths.');
    }
  };
  const record = (tool, callId, args, current, decision, reasonCode) => onDecision({
    type: 'tool/policy', projectId: ceiling.projectId, runId: ceiling.runId, callId, tool,
    capability: Object.hasOwn(DSH_FILE_TOOLS, tool) ? DSH_FILE_TOOLS[tool] : null, actor: 'system', policyVersion: current?.version ?? ceiling.version,
    decision, ...(reasonCode ? { reasonCode } : {}), ...(args ? { path: args.path } : {})
  });
  async function execute({ tool, callId, arguments: input } = {}) {
    let args;
    let current;
    try {
      if (typeof callId !== 'string' || !callId || callId.length > 200) throw fail('DSH_ARGUMENTS_INVALID', 'A bounded call identity is required.');
      args = parameters(tool, input, skillDocuments);
      current = policySnapshot(await readPolicy());
      check(current, tool, args);
      await record(tool, callId, args, current, 'allow');
      const final = policySnapshot(await readPolicy());
      check(final, tool, args);
      if (final.version !== current.version) throw fail('DSH_POLICY_CHANGED', 'The policy changed while recording the tool decision.');
      // No await from this last policy/cancellation check through the filesystem
      // operation. Other calls on this broker are serialized below.
      const file = resolveFile(root, args.path, tool === 'project_propose_patch');
      const content = file.exists ? readFile(file.path) : null;
      if (tool === 'project_read_file') {
        const sha256 = digest(content);
        const document = skillDocuments.get(args.path);
        if (document && (content.length !== document.bytes || sha256 !== document.sha256)) throw fail('DSH_SKILL_VERSION_CHANGED', 'The selected Skill document no longer matches its recorded version.');
        const lines = content.toString('utf8').split('\n');
        const selected = lines.slice(args.fromLine - 1, args.toLine).join('\n');
        if (Buffer.byteLength(selected) > 131_072) throw fail('DSH_OUTPUT_TOO_LARGE', 'Select fewer lines from this file.');
        emit({ type: 'file/read', data: { name: tool, callId, path: args.path, version: { exists: true, sha256 }, ...(document ? { skillSource: sourceForProjectedSkillRead(projection, args.path) } : {}) } });
        return { path: args.path, sha256, fromLine: args.fromLine, toLine: Math.min(lines.length, args.toLine), lineCount: lines.length, content: selected };
      }
      if ((content === null ? null : digest(content)) !== args.expectedSha256) throw fail('DSH_FILE_CONFLICT', 'The project file changed since it was read.');
      const temporary = path.join(path.dirname(file.path), `.scienceprism-proposal-${randomUUID()}`);
      try { fs.writeFileSync(temporary, args.content, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file.path); }
      finally { fs.rmSync(temporary, { force: true }); }
      return { path: args.path, sha256: digest(args.content), byteLength: Buffer.byteLength(args.content), proposed: true };
    } catch (reason) {
      try { await record(tool, callId, args, current, 'deny', reason.code || 'DSH_TOOL_FAILED'); }
      catch { throw fail('DSH_AUDIT_UNAVAILABLE', 'The project policy decision could not be persisted.'); }
      if (reason instanceof HarnessRuntimeError) throw reason;
      throw fail('DSH_TOOL_FAILED', 'The project tool could not complete.');
    }
  }
  return Object.freeze({
    ceiling,
    execute(call) {
      // Snapshot untrusted arguments before waiting for an earlier operation.
      const snapshot = call && { ...call, arguments: call.arguments && { ...call.arguments } };
      const operation = pending.then(() => execute(snapshot));
      pending = operation.catch(() => {});
      return operation;
    },
    close() { closed.abort(); return pending; }
  });
}
