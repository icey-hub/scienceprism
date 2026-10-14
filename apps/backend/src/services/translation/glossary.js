import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getProjectRoot } from '../projectService.js';
import { getPaper } from '../projectHub/paperLibrary.js';
import { withHubLock } from '../projectHub/repository.js';
import { createAttachmentRepository } from '../paperAttachments/repository.js';
import { safeJoin } from '../../utils/pathUtils.js';

const FILE = '.scienceprism/reading-glossary.json', MAX_BYTES = 32 * 1024 * 1024;
export class ReadingGlossaryError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'ReadingGlossaryError'; this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, status = 400) => { throw new ReadingGlossaryError(`GLOSSARY_${code}`, message, status); };
const validText = (max, required = true) => z.string().refine(value => value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && [...value].length <= max && (!required || value.trim().length > 0));
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const language = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/);
const rect = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).strict()
  .refine(r => r.x + r.width <= 1 + 1e-6 && r.y + r.height <= 1 + 1e-6);
const source = z.object({ paperId: identifier, attachmentId: identifier, fileSha256: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().min(1).max(100000), quote: validText(10000), rects: z.array(rect).min(1).max(128) }).strict();
const fields = z.object({ term: validText(200), definition: validText(4000), sourceLanguage: language, targetLanguage: language, source: source.nullable().optional() }).strict();
const entry = fields.extend({ id: z.string().regex(/^term-[a-f0-9-]{36}$/), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).refine(value => value.updatedAt >= value.createdAt);
const state = z.object({ schemaVersion: z.literal(1), projectId: identifier, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), entries: z.array(entry).max(1000) }).strict()
  .refine(value => new Set(value.entries.map(e => e.id)).size === value.entries.length);
function parse(schema, input, stored = false) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(stored ? 'STORAGE_INVALID' : 'INVALID_INPUT', stored ? '术语文件格式无效，请保留原文件检查。' : '请输入有效术语、释义、语言及规范的PDF选区来源。', stored ? 500 : 400);
  return parsed.data;
}
const request = payload => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_INPUT', '术语请求必须是对象。');
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) fail('REVISION_REQUIRED', '请先读取词表并发送expectedRevision。', 428);
  return payload;
};
export function createReadingGlossaryService({ resolveProject = getProjectRoot, lookupPaper = getPaper, attachments = createAttachmentRepository(), now = () => new Date().toISOString() } = {}) {
  async function location(projectId) {
    let root;
    try { root = await resolveProject(projectId); }
    catch (error) { if (error.code === 'ENOENT') fail('PROJECT_NOT_FOUND', '项目不存在。', 404); throw error; }
    return safeJoin(root, FILE);
  }
  async function load(projectId) {
    const file = await location(projectId); let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) fail('STORAGE_INVALID', '术语文件必须是大小受限的独立普通文件。', 500);
      const buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat();
      if (length !== before.size || before.size !== after.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) fail('STORAGE_INVALID', '术语文件读取期间发生变化。', 500);
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
      catch { fail('STORAGE_INVALID', '术语文件JSON或编码无效，请保留原文件。', 500); }
      const result = parse(state, value, true);
      if (result.projectId !== projectId) fail('STORAGE_INVALID', '术语文件项目归属不匹配。', 500);
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, projectId, revision: 0, entries: [] };
      throw error;
    } finally { await handle?.close(); }
  }
  async function save(projectId, value) {
    parse(state, value, true);
    const bytes = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(bytes) > MAX_BYTES) fail('CAPACITY', '项目术语存储达到32MiB上限。', 409);
    const file = await location(projectId); await fs.mkdir(path.dirname(file), { recursive: true }); await location(projectId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await location(projectId); await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function verifySource(projectId, value) {
    if (!value) return;
    try { await lookupPaper(projectId, value.paperId); }
    catch (error) { if (error.message === 'Paper not found.') fail('PAPER_NOT_FOUND', '来源论文不在当前项目。', 404); throw error; }
    // Reuse the attachment owner for real bytes/hash verification; never accept a client-only attachment.
    const { attachment } = await attachments.content(projectId, value.paperId, value.attachmentId);
    if (attachment.sha256 !== value.fileSha256) fail('SOURCE_VERSION_MISMATCH', 'PDF来源版本已变化，请重新选择文本。', 409);
    if (!Number.isInteger(attachment.pageCount) || value.page > attachment.pageCount) fail('SOURCE_PAGE_INVALID', '选区页码超出原PDF。');
  }
  const view = value => ({ entries: structuredClone(value.entries), revision: value.revision });
  async function change(projectId, body, allowed, operation, { actor = 'human' } = {}) {
    if (actor !== 'human') fail('HUMAN_INPUT_REQUIRED', '术语释义由人工保存，不由AI自动覆盖。', 403);
    request(body); if (Object.keys(body).some(key => !allowed.includes(key))) fail('INVALID_INPUT', '术语请求包含不支持字段。');
    return withHubLock(projectId, async () => {
      const current = await load(projectId);
      if (current.revision !== body.expectedRevision) fail('CONFLICT', '词表已经更新，请刷新并保留当前编辑后再保存。', 409);
      if (current.revision === Number.MAX_SAFE_INTEGER) fail('CAPACITY', '术语版本上限已到。', 409);
      const next = await operation(current.entries);
      current.entries = next; current.revision++;
      await save(projectId, current); return view(current);
    });
  }
  return {
    async list(projectId) { return view(await load(projectId)); },
    async create(projectId, body, options) {
      return change(projectId, body, ['expectedRevision', 'entry'], async current => {
        if (current.length >= 1000) fail('LIMIT', '项目最多收藏1000个术语。', 409);
        const input = parse(fields, body.entry); await verifySource(projectId, input.source);
        const stamp = now(); return [...current, { ...input, id: `term-${randomUUID()}`, createdAt: stamp, updatedAt: stamp }];
      }, options);
    },
    async update(projectId, entryId, body, options) {
      return change(projectId, body, ['expectedRevision', 'patch'], async current => {
        const old = current.find(e => e.id === entryId); if (!old) fail('NOT_FOUND', '本项目没有该术语。', 404);
        const patch = parse(fields.partial(), body.patch); if (!Object.keys(patch).length) fail('INVALID_INPUT', '请选择要修改的术语字段。');
        const input = parse(fields, { ...Object.fromEntries(Object.keys(fields.shape).map(k => [k, old[k]])), ...patch });
        await verifySource(projectId, input.source);
        return current.map(e => e.id === entryId ? { ...input, id: old.id, createdAt: old.createdAt, updatedAt: now() } : e);
      }, options);
    },
    async remove(projectId, entryId, body, options) {
      return change(projectId, body, ['expectedRevision'], current => {
        if (!current.some(e => e.id === entryId)) fail('NOT_FOUND', '本项目没有该术语。', 404);
        return current.filter(e => e.id !== entryId);
      }, options);
    }
  };
}
export const readingGlossaryService = createReadingGlossaryService();
