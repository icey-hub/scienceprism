import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { getProjectRoot } from '../projectService.js';
import { withHubLock } from '../projectHub/repository.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { AttachmentError, MAX_PDF_BYTES } from './download.js';

const INDEX = '.scienceprism/paper-attachments.json';
const DIRECTORY = '.scienceprism/paper-attachments';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function attachmentFilename(value) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.length > 240 || /[\\/\x00-\x1f\x7f]/.test(value) || !/\.pdf$/i.test(value)) {
    throw new AttachmentError('ATTACHMENT_INVALID_FILENAME', 'Choose a PDF filename without directory separators.');
  }
  return value.trim();
}

export async function validatePdf(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new AttachmentError('ATTACHMENT_INVALID_PDF', 'The uploaded file is empty or is not a PDF.');
  if (bytes.length > MAX_PDF_BYTES) throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'The PDF exceeds the 32 MiB limit.', 413);
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new AttachmentError('ATTACHMENT_INVALID_PDF', 'The file does not contain a PDF header.');
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (!pdf.getPageCount()) throw new Error('No pages');
    return pdf.getPageCount();
  } catch {
    throw new AttachmentError('ATTACHMENT_INVALID_PDF', 'This PDF is damaged, empty or password protected. Import an accessible PDF.');
  }
}

export function createAttachmentRepository({ resolveProject = getProjectRoot } = {}) {
  async function rootFor(projectId) {
    try { return await resolveProject(projectId); }
    catch (error) { throw new AttachmentError('ATTACHMENT_PROJECT_UNAVAILABLE', 'Project not found or unavailable.', error?.code === 'ENOENT' ? 404 : 400); }
  }
  function filePath(root, name) {
    try { return safeJoin(root, name); }
    catch { throw new AttachmentError('ATTACHMENT_UNSAFE_PATH', 'Attachment storage contains an unsafe path.', 400); }
  }
  async function read(projectId) {
    const root = await rootFor(projectId);
    try {
      const index = JSON.parse(await fs.readFile(filePath(root, INDEX), 'utf8'));
      if (index.schemaVersion !== 1 || index.projectId !== projectId || !Array.isArray(index.attachments) || !Array.isArray(index.jobs)) throw new Error('Invalid index');
      return index;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, projectId, version: 1, attachments: [], jobs: [] };
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError('ATTACHMENT_STORAGE_INVALID', 'The attachment index could not be read.', 500);
    }
  }
  async function update(projectId, change) {
    return withHubLock(projectId, async () => {
      const root = await rootFor(projectId);
      const index = await read(projectId);
      const result = await change(index, root);
      await fs.mkdir(filePath(root, '.scienceprism'), { recursive: true });
      const destination = filePath(root, INDEX);
      const temporary = filePath(root, `.scienceprism/.attachments-${randomUUID()}.tmp`);
      try {
        index.version++;
        await fs.writeFile(temporary, JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        filePath(root, INDEX);
        await fs.rename(temporary, destination);
      } finally { await fs.rm(temporary, { force: true }); }
      return structuredClone(result);
    });
  }
  async function store(projectId, paperId, bytes, metadata) {
    const filename = attachmentFilename(metadata.filename);
    const pageCount = await validatePdf(bytes);
    const sha256 = digest(bytes);
    return update(projectId, async (index, root) => {
      const duplicate = index.attachments.find(item => item.paperId === paperId && item.sha256 === sha256);
      if (!duplicate && index.attachments.length >= 5000) throw new AttachmentError('ATTACHMENT_STORAGE_LIMIT', 'This project has reached the attachment limit.', 409);
      await fs.mkdir(filePath(root, DIRECTORY), { recursive: true });
      const target = filePath(root, `${DIRECTORY}/${sha256}.pdf`);
      const temporary = filePath(root, `${DIRECTORY}/.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        try { await fs.link(temporary, target); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const storedPath = filePath(root, `${DIRECTORY}/${sha256}.pdf`);
          const stat = await fs.lstat(storedPath);
          if (!stat.isFile() || stat.size !== bytes.length) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH', 'Stored PDF content does not match its recorded hash.', 409);
          const previous = await fs.readFile(storedPath);
          if (digest(previous) !== sha256) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH', 'Stored PDF content does not match its recorded hash.', 409);
        }
      } finally { await fs.rm(temporary, { force: true }); }
      if (duplicate) {
        if (metadata.sourceUrl) {
          duplicate.sourceUrls = [...new Set([...(duplicate.sourceUrls || []), duplicate.sourceUrl, metadata.sourceUrl].filter(Boolean))];
          if (!duplicate.sourceUrl) { duplicate.sourceUrl = metadata.sourceUrl; duplicate.resolvedUrl = metadata.resolvedUrl || null; }
        }
        return { attachment: duplicate, duplicate: true };
      }
      const attachment = { id: `attachment-${sha256}`, paperId, sha256, byteLength: bytes.length, pageCount,
        filename, sourceUrl: metadata.sourceUrl || null, resolvedUrl: metadata.resolvedUrl || null,
        createdAt: new Date().toISOString(), contentType: 'application/pdf', source: metadata.sourceUrl ? 'download' : 'upload' };
      index.attachments.push(attachment);
      return { attachment, duplicate: false };
    });
  }
  async function content(projectId, paperId, attachmentId) {
    const attachment = (await read(projectId)).attachments.find(item => item.paperId === paperId && item.id === attachmentId);
    if (!attachment) throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'This PDF attachment was not found in the paper.', 404);
    if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new AttachmentError('ATTACHMENT_STORAGE_INVALID', 'Attachment hash is invalid.', 500);
    const root = await rootFor(projectId);
    let bytes;
    try {
      const target = filePath(root, `${DIRECTORY}/${attachment.sha256}.pdf`);
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.size !== attachment.byteLength || stat.size > MAX_PDF_BYTES) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH', 'Stored PDF content changed after import.', 409);
      bytes = await fs.readFile(target);
    }
    catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError('ATTACHMENT_FILE_UNAVAILABLE', 'The stored PDF file is missing or unreadable.', 404);
    }
    if (bytes.length !== attachment.byteLength || digest(bytes) !== attachment.sha256) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH', 'Stored PDF content changed after import. Import a new version instead.', 409);
    return { attachment, bytes };
  }
  return { read, update, store, content };
}
