import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HarnessRuntimeError } from './errors.js';
import { isPathAllowed } from './capabilities.js';
import { DSH_FILE_TOOLS } from './dshFileBroker.js';
import { withHubLock } from '../projectHub/repository.js';

const MAX_FILE_BYTES = 1_048_576;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 409) => { throw new HarnessRuntimeError(status, `CODEX_RECEIPT_${code}`, message); };
const identifier = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.union([identifier, z.number().finite()]);
const bindingSchema = z.object({ projectId: identifier, parentRunId: identifier, workerRunId: identifier, threadId: identifier, turnId: identifier,
  workerVersion: identifier, toolSchemaHash: hash, policyVersion: version, role: identifier, task: identifier }).strict();
const relativePath = z.string().min(1).max(1024).refine(value => !/[\\\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value)
  && !/^[A-Za-z]:/.test(value) && !value.split('/').some(part => !part || ['.', '..', '.codex'].includes(part)));
const readArgs = z.object({ path: relativePath, fromLine: z.number().int().min(1).optional(), toLine: z.number().int().min(1).optional() }).strict();
const patchArgs = z.object({ path: relativePath, content: z.string().refine(value => Buffer.byteLength(value) <= MAX_FILE_BYTES), expectedSha256: hash.nullable() }).strict();
const metadataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), path: relativePath, sha256: hash, fromLine: z.number().int().min(1), toLine: z.number().int().min(0),
    lineCount: z.number().int().min(1), contentSha256: hash }).strict(),
  z.object({ kind: z.literal('proposal'), path: relativePath, sha256: hash, byteLength: z.number().int().min(0).max(MAX_FILE_BYTES), proposed: z.literal(true) }).strict()
]);
const receiptSchema = z.object({ callId: identifier, tool: z.enum(['project_read_file', 'project_propose_patch']), requestHash: hash, path: relativePath,
  beforeSha256: hash.nullable(), afterSha256: hash, status: z.enum(['prepared', 'completed']), result: metadataSchema.nullable() }).strict()
  .refine(value => value.status === 'prepared' ? value.result === null : value.result !== null && value.path === value.result.path
    && value.afterSha256 === value.result.sha256 && (value.tool === 'project_read_file' ? value.result.kind === 'read' && value.beforeSha256 === value.afterSha256 : value.result.kind === 'proposal'));
const stateSchema = z.object({ schemaVersion: z.literal(1), workspace: z.string(), binding: bindingSchema, receipts: z.array(receiptSchema).max(128) }).strict()
  .refine(value => new Set(value.receipts.map(receipt => receipt.callId)).size === value.receipts.length);
function parse(schema, value, code = 'INPUT_INVALID') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code, 'The controlled tool receipt data is invalid.');
  return parsed.data;
}

function completionGrowth(receipt) {
  const result = receipt.tool === 'project_propose_patch'
    ? { kind: 'proposal', path: receipt.path, sha256: receipt.afterSha256, byteLength: MAX_FILE_BYTES, proposed: true }
    : { kind: 'read', path: receipt.path, sha256: receipt.afterSha256, fromLine: Number.MAX_SAFE_INTEGER,
      toLine: MAX_FILE_BYTES + 1, lineCount: MAX_FILE_BYTES + 1, contentSha256: receipt.afterSha256 };
  const completed = { ...receipt, status: 'completed', result };
  // Result metadata repeats the actual path (including UTF-8/JSON escapes).
  // Keep the prior floor, but reserve the serialized maximum for this tool.
  return Math.max(512, Buffer.byteLength(JSON.stringify(completed)) - Buffer.byteLength(JSON.stringify(receipt)));
}

function realDirectory(directory, create = false) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) fail('STORAGE_INVALID', 'A normalized private directory is required.');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('STORAGE_INVALID', 'Receipt storage requires real directories.');
  }
  if (fs.realpathSync(directory) !== directory) fail('STORAGE_INVALID', 'Receipt storage requires real directories.');
}

function boundedFile(root, relative, allowMissing, maxBytes = MAX_FILE_BYTES) {
  realDirectory(root);
  let file = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (allowMissing && index === parts.length - 1 && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('STORAGE_INVALID', 'Only regular files without links can provide receipt evidence.');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('STORAGE_INVALID', 'Only regular files can provide receipt evidence.');
    if (stat.size > maxBytes) fail('CAPACITY', 'Receipt evidence exceeds its byte limit.', 503);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) { const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes); if (!read) break; bytes += read; }
    if (bytes > maxBytes) fail('CAPACITY', 'Receipt evidence exceeds its byte limit.', 503);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

/** Durable receipts for the two existing file tools, not a Run owner or scheduler.
 * The caller must prove exclusive live-process ownership before reopening this
 * private directory. withHubLock only serializes callers in ONE backend process.
 * No arguments, read text, proposal text, provider credentials or raw errors are
 * persisted. A prepared receipt is ambiguous and can never authorize redispatch.
 */
export async function createCodexToolReceipts({ directory, workspace, binding: inputBinding, readPolicy, skillProjection,
  maxReceipts = 128, maxBytes = 4_194_304 } = {}) {
  const binding = parse(bindingSchema, inputBinding);
  if (typeof readPolicy !== 'function' || typeof directory !== 'string' || typeof workspace !== 'string'
    || !Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 128
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4_194_304) fail('INPUT_INVALID', 'Bounded receipt storage and a current Run policy are required.');
  if (directory === workspace || directory.startsWith(`${workspace}${path.sep}`) || workspace.startsWith(`${directory}${path.sep}`)) fail('STORAGE_INVALID', 'Private receipts must be separate from the model workspace.');
  try { realDirectory(workspace); realDirectory(directory, true); }
  catch (error) { if (error instanceof HarnessRuntimeError) throw error; fail('STORAGE_INVALID', 'The private receipt directories are unavailable.'); }
  const file = path.join(directory, 'tool-receipts.json');
  const skillDocuments = new Map();
  for (const document of skillProjection?.documents || []) {
    const manifest = parse(z.object({ projectionPath: relativePath.refine(value => /^\.dsh\/skills\/[a-z][a-z0-9-]*\/.+\.md$/.test(value)),
      sha256: hash, bytes: z.number().int().min(0).max(MAX_FILE_BYTES) }).passthrough(), document);
    if (skillDocuments.has(manifest.projectionPath)) fail('INPUT_INVALID', 'The selected Skill projection contains duplicate paths.');
    skillDocuments.set(manifest.projectionPath, manifest);
  }

  function description(call) {
    const value = parse(z.object({ threadId: identifier, turnId: identifier, callId: identifier, tool: z.enum(['project_read_file', 'project_propose_patch']), arguments: z.unknown() }).strict(), call);
    if (value.threadId !== binding.threadId || value.turnId !== binding.turnId) fail('IDENTITY_CONFLICT', 'The tool belongs to a different worker thread or turn.');
    let args = parse(value.tool === 'project_read_file' ? readArgs : patchArgs, value.arguments);
    if (value.tool === 'project_read_file') {
      args = { path: args.path, fromLine: args.fromLine ?? 1, toLine: args.toLine ?? (args.fromLine ?? 1) + 999 };
      if (args.toLine < args.fromLine || args.toLine - args.fromLine >= 1000) fail('INPUT_INVALID', 'Read at most 1000 numbered lines.');
    }
    if (args.path.split('/').includes('.dsh') && !(value.tool === 'project_read_file' && skillDocuments.has(args.path))) fail('POLICY_DENIED', 'Only selected Skill documents may be read from runtime directories.', 403);
    // Schemas and this explicit ordering normalize key order and read defaults.
    const semantic = value.tool === 'project_read_file' ? args : { path: args.path, content: args.content, expectedSha256: args.expectedSha256 };
    return { call: { ...value, arguments: args }, args, requestHash: digest(JSON.stringify({ tool: value.tool, arguments: semantic })) };
  }

  async function authorize(call, signal) {
    if (signal?.aborted) fail('CANCELLED', 'The controlled tool call was cancelled.');
    let policy;
    try { policy = await readPolicy(); } catch { fail('POLICY_DENIED', 'The current Run policy could not be verified.', 403); }
    const skill = call.tool === 'project_read_file' && skillDocuments.has(call.arguments.path);
    if (policy?.active !== true || policy.mode !== 'auto' || policy.projectId !== binding.projectId || policy.runId !== binding.workerRunId
      || policy.role !== binding.role || policy.task !== binding.task || policy.version !== binding.policyVersion
      || !['granted', 'allowedPaths', 'networkAllowlist'].every(key => Array.isArray(policy.capabilities?.[key]) && policy.capabilities[key].every(value => typeof value === 'string'))
      || !policy.capabilities.granted.includes(DSH_FILE_TOOLS[call.tool]) || !skill && !isPathAllowed(call.arguments.path, policy.capabilities)) fail('POLICY_DENIED', 'The current Run does not authorize this receipt or tool.', 403);
    if (signal?.aborted) fail('CANCELLED', 'The controlled tool call was cancelled.');
  }

  function load() {
    let content;
    try { content = boundedFile(directory, 'tool-receipts.json', true, maxBytes); }
    catch (error) { if (error instanceof HarnessRuntimeError) throw error; fail('STORAGE_UNAVAILABLE', 'The receipt store could not be read; preserve it for inspection.', 500); }
    if (content === null) return { schemaVersion: 1, workspace, binding, receipts: [] };
    let state;
    try { state = parse(stateSchema, JSON.parse(content.toString('utf8')), 'STORAGE_INVALID'); }
    catch (error) { if (error instanceof HarnessRuntimeError) throw error; fail('STORAGE_INVALID', 'The receipt store is invalid; preserve it for inspection.'); }
    if (state.workspace !== workspace || JSON.stringify(state.binding) !== JSON.stringify(binding)) fail('IDENTITY_CONFLICT', 'The receipt store belongs to another workspace or worker version.');
    return state;
  }

  function save(state) {
    parse(stateSchema, state, 'STORAGE_INVALID');
    const content = `${JSON.stringify(state)}\n`;
    // Reserve enough bytes for pending metadata to grow on completion; retain
    // all identities rather than silently evicting duplicate protection.
    const pendingGrowth = state.receipts.reduce((total, receipt) => total + (receipt.status === 'prepared' ? completionGrowth(receipt) : 0), 0);
    if (Buffer.byteLength(content) + pendingGrowth > maxBytes) fail('CAPACITY', 'The receipt store is full; existing identities were retained.', 503);
    const temporary = path.join(directory, `.tool-receipts-${randomUUID()}.tmp`);
    let fd;
    try {
      realDirectory(directory); boundedFile(directory, 'tool-receipts.json', true, maxBytes);
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      realDirectory(directory); fs.renameSync(temporary, file);
      const dir = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (error) { if (error instanceof HarnessRuntimeError) throw error; fail('STORAGE_UNAVAILABLE', 'The tool receipt could not be durably saved.', 500); }
    finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
  }

  function evidence(receipt, args) {
    let content;
    try { content = boundedFile(workspace, receipt.path, false); }
    catch { fail('RESULT_UNAVAILABLE', 'The persisted tool result has no matching file evidence.'); }
    if (content.includes(0) || digest(content) !== receipt.afterSha256) fail('RESULT_UNAVAILABLE', 'The worker file no longer matches the persisted result.');
    if (receipt.tool === 'project_propose_patch') {
      if (receipt.result && receipt.result.byteLength !== content.length) fail('RESULT_UNAVAILABLE', 'The persisted proposal byte count does not match the file.');
      return { path: receipt.path, sha256: receipt.afterSha256, byteLength: content.length, proposed: true };
    }
    const document = skillDocuments.get(receipt.path);
    if (document && (document.sha256 !== digest(content) || document.bytes !== content.length)) fail('RESULT_UNAVAILABLE', 'The selected Skill version no longer matches its receipt.');
    const lines = content.toString('utf8').split('\n');
    const result = { path: receipt.path, sha256: digest(content), fromLine: args.fromLine, toLine: Math.min(args.toLine, lines.length), lineCount: lines.length,
      content: lines.slice(args.fromLine - 1, args.toLine).join('\n') };
    if (Buffer.byteLength(result.content) > 131_072) fail('RESULT_UNAVAILABLE', 'The read result exceeds the controlled output limit.');
    const metadata = { kind: 'read', ...result, contentSha256: digest(result.content) }; delete metadata.content;
    if (receipt.result && JSON.stringify(metadata) !== JSON.stringify(receipt.result)) fail('RESULT_UNAVAILABLE', 'The reconstructed read differs from its persisted result.');
    return result;
  }

  return Object.freeze({
    execute(input, { executeTool, signal } = {}) {
      let described;
      try { described = description(input); if (typeof executeTool !== 'function') fail('INPUT_INVALID', 'The existing controlled broker is required.'); }
      catch (error) { return Promise.reject(error); }
      return withHubLock(file, async () => {
        const { call, args, requestHash } = described;
        await authorize(call, signal);
        const state = load();
        let receipt = state.receipts.find(value => value.callId === call.callId);
        if (receipt) {
          if (receipt.requestHash !== requestHash || receipt.tool !== call.tool || receipt.path !== args.path
            || call.tool === 'project_propose_patch' && (receipt.beforeSha256 !== args.expectedSha256 || receipt.afterSha256 !== digest(args.content))) fail('IDENTITY_CONFLICT', 'This tool call identity already belongs to different arguments.');
          if (receipt.status !== 'completed') fail('AMBIGUOUS', 'The earlier tool outcome is unknown; reconcile it without redispatch.');
          const result = evidence(receipt, args);
          await authorize(call, signal);
          return result;
        }
        if (state.receipts.length >= maxReceipts) fail('CAPACITY', 'The worker receipt identity limit has been reached.', 503);
        let before;
        try { before = boundedFile(workspace, args.path, call.tool === 'project_propose_patch'); }
        catch (error) { if (error instanceof HarnessRuntimeError) throw error; fail('RESULT_UNAVAILABLE', 'The tool input file is unavailable.'); }
        const beforeSha256 = before === null ? null : digest(before);
        if (call.tool === 'project_propose_patch' && beforeSha256 !== args.expectedSha256) fail('INPUT_CONFLICT', 'The proposal input file changed before receipt preparation.');
        receipt = { callId: call.callId, tool: call.tool, requestHash, path: args.path, beforeSha256,
          afterSha256: call.tool === 'project_propose_patch' ? digest(args.content) : beforeSha256, status: 'prepared', result: null };
        state.receipts.push(receipt); save(state);
        // The broker repeats policy/audit/CAS checks at the actual file operation.
        await authorize(call, signal);
        let result;
        try { result = await executeTool(call); }
        catch (error) { if (error instanceof HarnessRuntimeError) throw error; fail('OUTCOME_UNKNOWN', 'The prepared tool outcome is unknown; reconcile it without redispatch.'); }
        const verified = evidence(receipt, args);
        if (JSON.stringify(result) !== JSON.stringify(verified)) fail('RESULT_UNAVAILABLE', 'The controlled broker result does not match actual file evidence.');
        const metadata = call.tool === 'project_read_file' ? { kind: 'read', ...verified, contentSha256: digest(verified.content) } : { kind: 'proposal', ...verified };
        delete metadata.content;
        receipt.status = 'completed'; receipt.result = metadata; save(state);
        await authorize(call, signal);
        return verified;
      });
    }
  });
}
