import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safeJoin } from '../../utils/pathUtils.js';
import { resolveHarnessProjectRoot, withHarnessRunLock } from '../harnessRuntime/repository.js';
import { HarnessRuntimeError } from '../harnessRuntime/errors.js';
import { fileVersion, sameVersion } from '../harnessRuntime/fileVersions.js';
import { isSensitivePath } from '../harnessRuntime/capabilities.js';
import { rollbackFileTransaction, writeFileTransaction, writeTransactionFile } from '../harnessRuntime/fileTransactions.js';
import { collabFileMatches } from '../collab/docStore.js';
import { assertApprovedConstraint } from '../constraintRegistry/proposals.js';
import { getPaper, paperRevision } from './paperLibrary.js';
import { withHubLock } from './repository.js';
import { paperAttachmentService } from '../paperAttachments/index.js';
import { parseCitationBib, citationTexMask, assertCitationOffset, bibliographyLinked } from './manuscriptCitationBib.js';

const MAX_FILE = 2 * 1024 * 1024;
const DIRECTORY = '.scienceprism/manuscript-citations';
const fail = (status, code, message) => { throw new HarnessRuntimeError(status, code, message); };
const hash = content => createHash('sha256').update(content).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail(400, 'CITATION_REQUEST_INVALID', 'Use a stable citation request identifier.');
  return value;
}
function version(value) {
  if (!value || !(value.exists === false && value.sha256 === null || value.exists === true && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256))) fail(400, 'CITATION_VERSION_REQUIRED', 'Capture the exact saved document and Bib versions before inserting.');
  return { exists: value.exists, sha256: value.sha256 };
}
function manuscriptPath(value, extension) {
  if (typeof value !== 'string' || value.length > 500 || value !== path.posix.normalize(value) || /[\\\x00-\x1f\x7f{}%#]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part.startsWith('.')) || isSensitivePath(value) || !value.toLowerCase().endsWith(extension)) fail(400, 'CITATION_PATH_INVALID', 'Choose a visible project-relative TeX or Bib file.');
  return value;
}
function inputOf(input, apply = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'CITATION_INPUT_INVALID', 'A citation input is required.');
  const allowed = new Set(['paperId','texPath','bibPath','expectedTexVersion','expectedBibVersion','position','citationKey','readingSource','bibliographyImport','expectedPaperRevision',...(apply?['requestId']:[])]);
  if (Object.keys(input).some(key => !allowed.has(key))) fail(400, 'CITATION_INPUT_INVALID', 'Citation metadata must come from the project library.');
  if (typeof input.paperId !== 'string' || !input.paperId || input.paperId.length > 200) fail(400, 'CITATION_PAPER_REQUIRED', 'Choose a project library paper.');
  if (!input.position || Object.keys(input.position).some(key => key !== 'offset') || !Number.isSafeInteger(input.position.offset)) fail(400, 'CITATION_POSITION_REQUIRED', 'Choose an explicit saved-document insertion position.');
  const result = { paperId:input.paperId,texPath:manuscriptPath(input.texPath,'.tex'),bibPath:manuscriptPath(input.bibPath,'.bib'),expectedTexVersion:version(input.expectedTexVersion),expectedBibVersion:version(input.expectedBibVersion),position:{offset:input.position.offset} };
  if (input.expectedPaperRevision !== undefined || apply) {
    if (typeof input.expectedPaperRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedPaperRevision)) fail(400,'CITATION_PAPER_REVISION_REQUIRED','Preview the current library paper before inserting.');
    result.expectedPaperRevision = input.expectedPaperRevision;
  }
  if (input.citationKey !== undefined) {
    if (typeof input.citationKey !== 'string' || !/^[A-Za-z0-9_:./+-]{1,200}$/.test(input.citationKey)) fail(400,'CITATION_KEY_INVALID','Choose a literal BibTeX citation key.');
    result.citationKey = input.citationKey;
  }
  if (input.bibliographyImport !== undefined) {
    const item = input.bibliographyImport;
    if (!item || !['bibtex','biblatex'].includes(item.kind) || !Number.isSafeInteger(item.offset) || Object.keys(item).some(key => !['kind','offset'].includes(key))) fail(400,'CITATION_IMPORT_INVALID','Choose an explicit bibliography command and position.');
    result.bibliographyImport = {kind:item.kind,offset:item.offset};
  }
  if (input.readingSource !== undefined) {
    const item = input.readingSource;
    if (!item || typeof item.attachmentId !== 'string' || !item.attachmentId || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.page) || item.page < 1 || Object.keys(item).some(key => !['attachmentId','sha256','page','selectionId'].includes(key)) || item.selectionId !== undefined && (typeof item.selectionId !== 'string' || !item.selectionId)) fail(400,'CITATION_SOURCE_INVALID','Use the actual PDF version, page and saved annotation.');
    result.readingSource = {...item};
  }
  if (apply) result.requestId = identifier(input.requestId);
  return result;
}
async function readStrict(root, relativePath, limit = MAX_FILE) {
  let handle;
  try {
    handle = await fs.open(safeJoin(root,relativePath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail(409,'CITATION_FILE_UNSAFE','Only bounded ordinary single-link document files can be changed.');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes,length,bytes.length-length,length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) fail(409,'CITATION_VERSION_CONFLICT','The source file changed while reading.');
    let content;
    try { content = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length)); }
    catch { fail(409,'CITATION_UTF8_INVALID','Keep the original bytes; this file is not valid UTF-8.'); }
    return {...fileVersion(content),content};
  } catch (error) {
    if (error.code === 'ENOENT') return {...fileVersion(null),content:''};
    throw error;
  } finally { await handle?.close(); }
}
async function sourceOf(projectId,input) {
  const paper = await getPaper(projectId,input.paperId), revision = paperRevision(paper);
  if (input.expectedPaperRevision !== undefined && revision !== input.expectedPaperRevision) fail(409,'CITATION_PAPER_CHANGED','The library record changed after preview; refresh the preview.');
  const source = {paperId:paper.id,paperRevision:revision,paper:structuredClone(paper),verificationStatus:'unverified'};
  if (input.readingSource) {
    const item = input.readingSource, {attachment} = await paperAttachmentService.content(projectId,paper.id,item.attachmentId);
    if (attachment.sha256 !== item.sha256 || item.page > attachment.pageCount) fail(409,'CITATION_SOURCE_CHANGED','The PDF version or page no longer matches this citation.');
    if (item.selectionId) {
      const note = (paper.annotations || []).find(note => note.id === item.selectionId), anchor = note?.anchor;
      if (!anchor || anchor.attachmentId !== item.attachmentId || anchor.fileSha256 !== item.sha256 || anchor.page !== item.page) fail(409,'CITATION_ANNOTATION_CHANGED','The saved annotation no longer matches this PDF page.');
      source.annotation = structuredClone(note);
    }
    source.readingSource = {...item};
    source.attachment = structuredClone(attachment);
  }
  return source;
}
function prepareText(input,tex,bib,paper) {
  let incoming,existing;
  try {
    incoming = parseCitationBib(String(paper.bibtex || ''));
    if (incoming.length !== 1 || String(paper.bibtex).slice(0,incoming[0].start).trim() || String(paper.bibtex).slice(incoming[0].end).trim()) throw new Error('Library BibTeX must contain exactly one complete entry');
    existing = parseCitationBib(bib.content);
  } catch (error) { fail(409,'CITATION_BIB_INVALID',error.message); }
  const original = incoming[0], key = input.citationKey || original.key;
  let bibEntry = original.raw;
  if (key !== original.key) { const offset = original.keyStart-original.start; bibEntry = bibEntry.slice(0,offset)+key+bibEntry.slice(offset+original.key.length); }
  const candidate = parseCitationBib(bibEntry)[0], matches = existing.filter(entry => entry.key === key);
  if (matches.length > 1) fail(409,'CITATION_BIB_CONFLICT',`Bib key ${key} has multiple entries; resolve the duplicate before inserting.`);
  if (matches.some(entry => entry.fingerprint !== candidate.fingerprint)) fail(409,'CITATION_BIB_CONFLICT',`Bib key ${key} already describes another complete entry; choose another key.`);
  const bibContent = matches.length ? bib.content : `${bib.content}${bib.content && !bib.content.endsWith('\n')?'\n':''}${bibEntry}\n`;
  let mask;
  try { mask = citationTexMask(tex.content); assertCitationOffset(tex.content,input.position.offset,mask); }
  catch (error) { fail(400,'CITATION_POSITION_INVALID',error.message); }
  const begin = /\\begin\s*\{\s*document\s*\}/.exec(mask.text), end = /\\end\s*\{\s*document\s*\}/.exec(mask.text);
  if (begin && (!end || input.position.offset < begin.index+begin[0].length || input.position.offset > end.index)) fail(400,'CITATION_POSITION_INVALID','Insert the citation inside the saved document body.');
  const linked = bibliographyLinked(input.texPath,input.bibPath,mask.text), snippet = `\\cite{${key}}`;
  let content = tex.content.slice(0,input.position.offset)+snippet+tex.content.slice(input.position.offset), from = input.position.offset, importPreview;
  if (!linked && input.bibliographyImport) {
    const item = input.bibliographyImport;
    try { assertCitationOffset(tex.content,item.offset,mask); } catch (error) { fail(400,'CITATION_IMPORT_INVALID',error.message); }
    if (begin && (item.kind === 'biblatex' ? item.offset > begin.index : item.offset < begin.index+begin[0].length || item.offset > end.index)) fail(400,'CITATION_IMPORT_INVALID','Place addbibresource in the preamble, or bibliography in the document body.');
    // The compiler runs from the project input root, including nested TeX files.
    let relative = input.bibPath;
    if (/[{}%#$^~&\\]/.test(relative)) fail(400,'CITATION_IMPORT_INVALID','The bibliography path cannot form a literal TeX argument.');
    if (item.kind === 'bibtex') relative = relative.replace(/\.bib$/i,'');
    if (relative.trim() !== relative) fail(400,'CITATION_IMPORT_INVALID','Use a bibliography filename without leading or trailing argument spaces.');
    const text = `\n\\${item.kind==='bibtex'?'bibliography':'addbibresource'}{${relative}}\n`;
    const offset = item.offset + (item.offset >= input.position.offset ? snippet.length : 0);
    content = content.slice(0,offset)+text+content.slice(offset);
    if (item.offset < input.position.offset) from += text.length;
    importPreview = {...item,text};
  }
  if (Buffer.byteLength(content)>MAX_FILE || Buffer.byteLength(bibContent)>MAX_FILE) fail(413,'CITATION_SIZE_LIMIT','The resulting document or Bib exceeds 2 MiB.');
  return {citationKey:key,bibEntry,texPreview:content,bibContent,bibliographyLinked:linked || Boolean(importPreview),importPreview,from,to:from+snippet.length,line:content.slice(0,from).split('\n').length};
}
async function prepare(projectId,root,input) {
  const source = await sourceOf(projectId,input);
  const tex = await readStrict(root,input.texPath), bib = await readStrict(root,input.bibPath);
  if (!tex.exists || !sameVersion(tex,input.expectedTexVersion) || !sameVersion(bib,input.expectedBibVersion)) fail(409,'CITATION_VERSION_CONFLICT','The saved document or Bib changed; preview again.');
  for (const [file,state] of [[input.texPath,tex],[input.bibPath,bib]]) {
    if (!collabFileMatches(`${projectId}:${file}`,state)) fail(409,'CITATION_DRAFT_CONFLICT','A collaborative draft has unsaved changes.');
    await assertApprovedConstraint(projectId,{kind:'patch.forbid_path',path:file});
  }
  const output = prepareText(input,tex,bib,source.paper);
  await assertApprovedConstraint(projectId,{kind:'patch.forbid_text',content:output.texPreview});
  await assertApprovedConstraint(projectId,{kind:'patch.forbid_text',content:output.bibContent});
  return {source,output,entries:[{path:input.texPath,before:tex,after:{...fileVersion(output.texPreview),content:output.texPreview}},{path:input.bibPath,before:bib,after:{...fileVersion(output.bibContent),content:output.bibContent}}]};
}
const journalPath = requestId => `${DIRECTORY}/${identifier(requestId)}.json`;
async function readRequest(root,requestId) {
  const state = await readStrict(root,journalPath(requestId),8*MAX_FILE);
  if (!state.exists) return null;
  let value; try { value = JSON.parse(state.content); } catch { fail(500,'CITATION_JOURNAL_INVALID','The citation recovery journal is unreadable.'); }
  if (value.schemaVersion !== 1 || value.requestId !== requestId || !['applying','applied','rolled_back','recovery_required'].includes(value.status)) fail(500,'CITATION_JOURNAL_INVALID','The citation recovery journal has an unsupported shape.');
  const input = inputOf(value.input,true);
  if (!['human','researcher'].includes(value.actor) || value.requestSha256 !== hash(JSON.stringify(canonical({projectId:value.projectId,actor:value.actor,input}))) || value.source?.paperId !== input.paperId || value.source?.paperRevision !== input.expectedPaperRevision) fail(500,'CITATION_JOURNAL_INVALID','The citation journal input or source changed.');
  if (['applying','recovery_required'].includes(value.status)) {
    if (!Array.isArray(value.entries) || value.entries.length !== 2) fail(500,'CITATION_JOURNAL_INVALID','The citation recovery entries are incomplete.');
    for (const [index,target] of [input.texPath,input.bibPath].entries()) {
      const entry=value.entries[index], expected=index===0?input.expectedTexVersion:input.expectedBibVersion;
      if (entry?.path !== target || typeof entry.before?.content !== 'string' || typeof entry.after?.content !== 'string' || Buffer.byteLength(entry.before.content)>MAX_FILE || Buffer.byteLength(entry.after.content)>MAX_FILE || !sameVersion(entry.before,expected) || !sameVersion(entry.before,fileVersion(entry.before.exists?entry.before.content:null)) || !entry.after.exists || !sameVersion(entry.after,fileVersion(entry.after.content))) fail(500,'CITATION_JOURNAL_INVALID','The citation recovery file snapshots changed.');
    }
  }
  if (value.status==='applied' && (!value.receipt || value.receipt.transactionId!==value.id || value.receipt.tex?.path!==input.texPath || value.receipt.bib?.path!==input.bibPath)) fail(500,'CITATION_JOURNAL_INVALID','The applied citation receipt is incomplete.');
  return value;
}
async function persist(root,journal) {
  await writeTransactionFile(root,journalPath(journal.requestId),{exists:true,content:JSON.stringify(journal,null,2)+'\n'});
}
function envelope(journal) {
  return {ok:true,requestId:journal.requestId,status:journal.status,transactionId:journal.id,receipt:journal.receipt||null,error:journal.error,source:journal.source};
}
export async function previewManuscriptCitation(projectId,rawInput,{actor}={}) {
  if (!['human','researcher'].includes(actor)) fail(403,'CITATION_HUMAN_REQUIRED','Citation insertion needs an explicit human action.');
  const input = inputOf(rawInput), root = await resolveHarnessProjectRoot(projectId);
  return withHarnessRunLock(projectId,()=>withHubLock(projectId,async()=> {
    const {source,output} = await prepare(projectId,root,input);
    return {ok:true,citationKey:output.citationKey,bibEntry:output.bibEntry,texPreview:output.texPreview,bibliographyLinked:output.bibliographyLinked,importPreview:output.importPreview,source:{...source,citationKey:output.citationKey}};
  }));
}
export async function getManuscriptCitationRequest(projectId,requestId) {
  const root = await resolveHarnessProjectRoot(projectId), journal = await readRequest(root,identifier(requestId));
  if (!journal) fail(404,'CITATION_REQUEST_NOT_FOUND','This citation request has no saved journal.');
  if (journal.projectId !== projectId) fail(500,'CITATION_JOURNAL_INVALID','The recovery journal belongs to another project.');
  return envelope(journal);
}
export async function applyManuscriptCitation(projectId,rawInput,{actor}={}) {
  if (!['human','researcher'].includes(actor)) fail(403,'CITATION_HUMAN_REQUIRED','Citation insertion needs an explicit human action.');
  const input = inputOf(rawInput,true), root = await resolveHarnessProjectRoot(projectId), requestSha256 = hash(JSON.stringify(canonical({projectId,actor,input})));
  return withHarnessRunLock(projectId,()=>withHubLock(projectId,async()=> {
    const previous = await readRequest(root,input.requestId);
    if (previous) {
      if (previous.projectId !== projectId || previous.requestSha256 !== requestSha256) fail(409,'CITATION_REQUEST_MISMATCH','Keep the same citation request and payload while recovering.');
      if (previous.status === 'applied') return previous.receipt;
      if (['applying','recovery_required'].includes(previous.status)) {
        await rollbackFileTransaction(root,previous,projectId,readStrict);
        await persist(root,previous);
      }
      fail(409,previous.status === 'recovery_required'?'CITATION_RECOVERY_REQUIRED':'CITATION_ROLLED_BACK',previous.status === 'recovery_required'?'Newer user content was preserved. Resolve this recovery journal before another insertion.':'The interrupted insertion was rolled back; preview the current files before a new request.');
    }
    // Pending transactions may touch these files. Never start a second request
    // until the original request has been resolved through its own journal.
    let names=[]; try { names=await fs.readdir(safeJoin(root,DIRECTORY)); } catch(error) { if(error.code!=='ENOENT')throw error; }
    if (names.length >= 1000) fail(409,'CITATION_RETENTION_LIMIT','Review the retained citation requests before adding more.');
    for (const name of names.filter(name=>name.endsWith('.json'))) {
      const saved = await readRequest(root,name.slice(0,-5));
      if (['applying','recovery_required'].includes(saved?.status) && saved.entries?.some(entry=>entry.path===input.texPath||entry.path===input.bibPath)) fail(409,'CITATION_RECOVERY_REQUIRED','Resolve the original citation request touching these files first.');
    }
    const {source,output,entries} = await prepare(projectId,root,input);
    if (!output.bibliographyLinked) fail(409,'CITATION_BIB_UNLINKED','Choose an explicit bibliography import before saving the citation.');
    const journal = {schemaVersion:1,projectId,requestId:input.requestId,requestSha256:requestSha256,id:randomUUID(),status:'applying',actor,startedAt:new Date().toISOString(),source:{...source,citationKey:output.citationKey},input,entries};
    await persist(root,journal);
    try {
      await writeFileTransaction({root,projectId,entries,readState:readStrict,beforePublish:async()=> {
        await sourceOf(projectId,{...input,expectedPaperRevision:source.paperRevision});
        for (const entry of entries) if (!sameVersion(await readStrict(root,entry.path),entry.after)) fail(409,'CITATION_VERSION_CONFLICT','The document changed while publishing this insertion.');
      }});
      const receipt = {ok:true,citationKey:output.citationKey,source:journal.source,tex:{path:input.texPath,version:fileVersion(output.texPreview),line:output.line,from:output.from,to:output.to},bib:{path:input.bibPath,version:fileVersion(output.bibContent)},transactionId:journal.id};
      journal.status='applied'; journal.appliedAt=new Date().toISOString(); journal.receipt=receipt;
      delete journal.entries;
      await persist(root,journal);
      return receipt;
    } catch (error) {
      // The success journal may have failed. The in-memory original entries are
      // still required to restore files without overwriting newer user content.
      journal.entries=entries; delete journal.receipt;
      await rollbackFileTransaction(root,journal,projectId,readStrict);
      journal.error={code:error.code||'WRITE_FAILED',message:error.message};
      if (journal.status==='rolled_back') delete journal.entries;
      try { await persist(root,journal); } catch { /* Pre-write journal survives for same-request recovery. */ }
      fail(journal.status==='recovery_required'?409:500,journal.status==='recovery_required'?'CITATION_RECOVERY_REQUIRED':'CITATION_APPLICATION_FAILED',journal.status==='recovery_required'?'Newer user content was preserved; recover this original request.':'The citation insertion failed; the original document and Bib were restored.');
    }
  }));
}
