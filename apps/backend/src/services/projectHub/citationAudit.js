import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { getProjectRoot } from '../projectService.js';
import { safeJoin } from '../../utils/pathUtils.js';

const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024;
const ignored = new Set(['node_modules', 'assets', 'cache', 'dist', 'build', '__pycache__']);
const issue = (code, message, location = {}) => ({ code, message, ...location });
export async function readCitationManuscript(projectId) {
  const root = await getProjectRoot(projectId), files = [], issues = []; let total = 0, count = 0, visited = 0, stopped = false;
  async function visit(relative) {
    let entries;
    try { entries = await fs.readdir(relative ? safeJoin(root, relative) : root, { withFileTypes: true }); }
    catch { issues.push(issue('MANUSCRIPT_READ_FAILED', '无法读取文稿目录；静态核查不完整。', { path: relative || '.' })); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      if (++visited > 5000) { issues.push(issue('MANUSCRIPT_SCAN_LIMIT', '项目目录扫描超过5000项，核查不完整。')); stopped = true; return; }
      if (entry.isSymbolicLink()) { issues.push(issue('MANUSCRIPT_SYMLINK_REJECTED', '不读取符号链接；其文稿/引用来源未核查。', { path: name })); continue; }
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!/\.(tex|bib|md)$/i.test(entry.name)) continue;
      if (++count > 500) { issues.push(issue('MANUSCRIPT_FILE_LIMIT', '文稿读取超过500文件，核查不完整。')); stopped = true; return; }
      let handle;
      try {
        handle = await fs.open(safeJoin(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE || total + before.size > MAX_TOTAL) {
          issues.push(issue('MANUSCRIPT_SIZE_LIMIT', '只读取普通单链接文稿，每文件≤2MiB、总量≤20MiB；该文件未核查。', { path: name })); continue;
        }
        total += before.size;
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
        const bytes = buffer.subarray(0, length), after = await handle.stat();
        if (length !== before.size) throw new Error('File size changed while reading');
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Changed while reading');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        files.push({ path: name, content });
      } catch { issues.push(issue('MANUSCRIPT_READ_FAILED', '文件读取失败、路径变化或UTF-8无效，未核查。', { path: name })); }
      finally { await handle?.close(); }
    }
  }
  await visit(''); return { files, issues };
}
const blank = text => text.replace(/[^\n]/g, ' ');
const escaped = (text, index) => { let n = 0; while (index > 0 && text[--index] === '\\') n++; return n % 2 === 1; };
function maskTex(source, issues, filePath) {
  const text = source; // Strip comments before recognizing environments; commented begin/end commands are inert.
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '%' && !escaped(text, i)) { const end = text.indexOf('\n', i); const next = end < 0 ? text.length : end; out += blank(text.slice(i, next)); i = next; continue; }
    if (text[i] === '\\' && !escaped(text, i) && /^\\verb\*?[^A-Za-z\s]/.test(text.slice(i))) {
      const prefix = text.slice(i).match(/^\\verb\*?/)[0], delimiter = text[i + prefix.length];
      const end = text.indexOf(delimiter, i + prefix.length + 1), lineEnd = text.indexOf('\n', i);
      if (end < 0 || lineEnd >= 0 && end > lineEnd) issues.push(issue('TEX_LITERAL_UNCLOSED', '行内verbatim未闭合，引用核查不完整。', { path: filePath }));
      const next = end >= 0 && (lineEnd < 0 || end < lineEnd) ? end + 1 : lineEnd < 0 ? text.length : lineEnd;
      out += blank(text.slice(i, next)); i = next; continue;
    }
    out += text[i++];
  }
  out = out.replace(/\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}[\s\S]*?\\end\s*\{\1\}/g, blank);
  if (/\\begin\s*\{(?:verbatim\*?|Verbatim|lstlisting|minted|comment)\}/.test(out)) issues.push(issue('TEX_LITERAL_UNCLOSED', 'verbatim类环境未闭合，引用核查不完整。', { path: filePath }));
  return out;
}
function lineLocator(text) {
  const starts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return index => { let lo = 0, hi = starts.length; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid; } return lo + 1; };
}
function balanced(text, start, open, close) {
  if (text[start] !== open) return null;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped(text, i)) continue;
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return { value: text.slice(start + 1, i), end: i + 1 };
  }
  return null;
}
function argumentsAt(text, index, optional = true) {
  let i = index;
  const whitespace = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  whitespace();
  if (optional) for (let n = 0; n < 2 && text[i] === '['; n++) { const arg = balanced(text, i, '[', ']'); if (!arg) return null; i = arg.end; whitespace(); }
  return balanced(text, i, '{', '}');
}

// Shield common command definitions; this is deliberately not a TeX interpreter.
function maskDefinitions(text, issues, filePath) {
  const macros = new Set(), pattern = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef)\*?\s*(?:\{\s*\\([A-Za-z]+)\s*\}|\\([A-Za-z]+))/g;
  let match;
  while ((match = pattern.exec(text))) {
    const body = ['def', 'gdef', 'edef', 'xdef'].includes(match[1]) ? balanced(text, text.indexOf('{', pattern.lastIndex), '{', '}') : argumentsAt(text, pattern.lastIndex);
    if (!body) { issues.push(issue('TEX_MACRO_UNSUPPORTED', '宏定义未能静态解析；不执行宏判断引用。', { path: filePath })); continue; }
    if (/\\(?:cite\w*|parencite|textcite|autocite|bibliography|addbibresource|bibitem)\b/.test(body.value)) macros.add(match[2] || match[3]);
    text = text.slice(0, match.index) + blank(text.slice(match.index, body.end)) + text.slice(body.end); pattern.lastIndex = body.end;
  }
  return { text, macros };
}
const doi = value => String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi\s*:\s*/i, '').toLowerCase();
const arxiv = value => String(value || '').trim().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
const validKey = key => key.length > 0 && key.length <= 200 && !/[\s{}\\#%]/.test(key);
function bibLocations(text) {
  const rows = [], lineAt = lineLocator(text); let match;
  const pattern = /@([A-Za-z]+)\s*([({])/g;
  while ((match = pattern.exec(text))) {
    const start = match.index, parsed = balanced(text, pattern.lastIndex - 1, match[2], match[2] === '{' ? '}' : ')');
    if (!parsed) throw new Error(`Unclosed BibTeX entry at line ${lineAt(start)}`);
    const kind = match[1].toLowerCase();
    if (!['comment', 'string', 'preamble'].includes(kind)) rows.push({ key: parsed.value.split(',')[0].trim(), line: lineAt(start) });
    pattern.lastIndex = parsed.end;
  }
  return rows;
}
function canonicalEntry(entry) {
  return JSON.stringify([entry.type.toLowerCase(), Object.entries(entry.properties).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])]);
}
export function auditCitations(files, papers = [], { issues: inputIssues = [] } = {}) {
  const issues = [...inputIssues], occurrences = new Map(), entries = new Map(), linked = new Set(), bibFiles = new Set(files.filter(f => /\.bib$/i.test(f.path)).map(f => f.path));
  const addEntry = (key, entry) => { entries.set(key, [...(entries.get(key) || []), entry]); };
  let occurrenceCount = 0;
  for (const file of files.filter(f => /\.bib$/i.test(f.path))) {
    try {
      const parsed = plugins.input.data(file.content, '@bibtex/text'), locations = bibLocations(file.content);
      if (parsed.length > 10000 || parsed.length !== locations.length) throw new Error('BibTeX entries could not be mapped completely to source positions');
      parsed.forEach((e, i) => {
        if (e.label !== locations[i].key || !validKey(e.label)) throw new Error('Unsupported or unmapped BibTeX key');
        const f = e.properties;
        addEntry(e.label, { path: file.path, line: locations[i].line, title: String(f.title || ''), doi: String(f.doi || ''), url: String(f.url || ''),
          arxivId: /^arxiv$/i.test(f.archiveprefix || f.eprinttype || '') ? String(f.eprint || '') : '', fingerprint: canonicalEntry(e), inline: false });
      });
    } catch (error) { issues.push(issue('BIB_PARSE_FAILED', `BibTeX离线解析不完整：${String(error.message).slice(0, 250)}`, { path: file.path })); }
  }
  for (const file of files.filter(f => /\.tex$/i.test(f.path))) {
    const masked = maskDefinitions(maskTex(file.content, issues, file.path), issues, file.path), text = masked.text, lineAt = lineLocator(text), command = /\\([A-Za-z]+)(\*)?/g; let match;
    while ((match = command.exec(text))) {
      if (occurrenceCount >= 20000) { issues.push(issue('CITATION_LIMIT', '引用位置达到20000，剩余文稿未核查。', { path: file.path })); break; }
      if (escaped(text, match.index)) continue;
      const name = match[1], location = { path: file.path, line: lineAt(match.index) };
      if (masked.macros.has(name)) { issues.push(issue('TEX_MACRO_UNSUPPORTED', `引用/导入使用自定义宏\\${name}；本片不展开宏。`, location)); continue; }
      if (name.startsWith('if') || ['newenvironment', 'renewenvironment'].includes(name)) issues.push(issue('TEX_SEMANTICS_UNSUPPORTED', 'TeX条件或环境定义未解释；项目级静态引用需核对编译入口。', location));
      if (['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite'].includes(name)) {
        const arg = argumentsAt(text, command.lastIndex);
        if (!arg) { issues.push(issue('CITATION_SYNTAX_UNSUPPORTED', '无法解析引用参数；静态核查不完整。', location)); continue; }
        for (const key of arg.value.split(',').map(k => k.trim())) {
          if (!validKey(key)) { issues.push(issue('CITATION_KEY_UNSUPPORTED', '引用键含宏或不支持语法；不执行宏推断键。', location)); continue; }
          if (++occurrenceCount > 20000) { issues.push(issue('CITATION_LIMIT', '引用位置超过20000，核查不完整。', location)); break; }
          occurrences.set(key, [...(occurrences.get(key) || []), location]);
        }
        command.lastIndex = arg.end;
      } else if (['bibliography', 'addbibresource'].includes(name)) {
        const arg = argumentsAt(text, command.lastIndex);
        if (!arg) { issues.push(issue('BIB_IMPORT_UNSUPPORTED', '无法解析文稿Bib导入。', location)); continue; }
        for (const raw of (name === 'bibliography' ? arg.value.split(',') : [arg.value])) {
          const value = raw.trim(), target = /\.bib$/i.test(value) ? value : `${value}.bib`;
          if (!value || /[\\{}#%]|^[a-z]+:|^\//i.test(value) || value.split('/').includes('..')) { issues.push(issue('BIB_IMPORT_UNSUPPORTED', 'Bib导入路径含宏、外部路径或不支持语法。', location)); continue; }
          const candidates = [...new Set([path.posix.normalize(target), path.posix.join(path.posix.dirname(file.path), target)])].filter(p => bibFiles.has(p));
          if (!candidates.length) issues.push(issue('BIB_IMPORT_MISSING', `文稿导入的Bib文件不存在或未读取：${value}`, location));
          else if (candidates.length > 1) issues.push(issue('BIB_IMPORT_AMBIGUOUS', `Bib根目录与相对路径同时存在：${value}，需核对编译入口。`, location));
          else linked.add(candidates[0]);
        }
        command.lastIndex = arg.end;
      } else if (name === 'bibitem') {
        const arg = argumentsAt(text, command.lastIndex);
        const preceding = text.slice(0, match.index), begin = preceding.lastIndexOf('\\begin{thebibliography}'), end = preceding.lastIndexOf('\\end{thebibliography}');
        if (!arg || begin < 0 || end > begin || !validKey(arg.value.trim())) { issues.push(issue('BIBITEM_UNSUPPORTED', 'bibitem需位于真实thebibliography环境并使用字面键。', location)); continue; }
        const next = text.slice(arg.end).search(/\\(?:bibitem\b|end\s*\{thebibliography\})/), body = text.slice(arg.end, next < 0 ? text.length : arg.end + next).trim();
        addEntry(arg.value.trim(), { ...location, title: body.slice(0, 1000), doi: '', url: '', fingerprint: `inline:${body}`, inline: true });
        command.lastIndex = arg.end;
      } else if (/^(?:cite|parencite|textcite|autocite|footcite|nocite)/i.test(name)) {
        issues.push(issue('CITATION_COMMAND_UNSUPPORTED', `本片未解析\\${name}；不执行宏或把未支持语法报告为通过。`, location));
      }
    }
  }
  for (const [key, values] of entries) if (new Set(values.map(e => e.fingerprint)).size > 1 && !occurrences.has(key)) issues.push(issue('BIB_KEY_CONFLICT', `未引用Bib键${key}也存在不同条目；项目静态来源需核对。`, { path: values[0].path, line: values[0].line }));
  const rows = [...occurrences].map(([key, locations]) => {
    const bib = entries.get(key) || [], identifiers = bib.flatMap(e => [{ doi: doi(e.doi), arxiv: arxiv(e.arxivId || (/arxiv\.org\//i.test(e.url) ? e.url : '')) }]);
    const matches = papers.filter(p => identifiers.some(id => id.doi && id.doi === doi(p.doi) || id.arxiv && id.arxiv === arxiv(p.arxivId || (/arxiv\.org\//i.test(p.url || '') ? p.url : ''))));
    const candidates = matches.length ? matches.map(p => ({ ...p, match: 'identifier' })) : papers.filter(p => p.citationKey === key || String(p.bibtex || '').match(/@\w+\s*\{\s*([^,\s]+)/)?.[1] === key).map(p => ({ ...p, match: 'key' }));
    const rowIssues = [], conflicts = new Set(bib.map(e => e.fingerprint)).size > 1;
    let status;
    if (!bib.length) { status = 'missing-bib'; rowIssues.push(candidates.length ? '资料库已有候选，但文稿Bib/bibitem没有该键；未自动导入。' : '文稿缺少真实Bib条目或bibitem。'); }
    else if (conflicts) { status = 'conflict'; rowIssues.push('同键存在不同Bib条目，请明确统一来源。'); }
    else if (bib.every(e => e.inline)) status = 'inline';
    else if (!bib.some(e => e.inline || linked.has(e.path))) { status = 'unlinked-bib'; rowIssues.push('项目Bib存在此键，但项目TeX未发现对应bibliography/addbibresource导入。'); }
    else status = 'resolved';
    if (candidates.some(p => p.match === 'key')) rowIssues.push('资料库匹配仅凭引用键，是候选关联，不是已验证论文来源。');
    if (matches.length > 1) rowIssues.push('同一标识符匹配多个资料库记录，需人工核对。');
    return { key, status, occurrences: locations, bibEntries: bib.map(({ path, line, title, doi, url }) => ({ path, line, title, doi, url })),
      papers: candidates.map(({ id, title, doi, url, match }) => ({ id, title, doi, url, match })), issues: rowIssues };
  });
  const summary = { total: rows.length, resolved: rows.filter(r => ['resolved', 'inline'].includes(r.status)).length, missing: rows.filter(r => r.status === 'missing-bib').length,
    conflicts: rows.filter(r => r.status === 'conflict').length, unlinked: rows.filter(r => r.status === 'unlinked-bib').length };
  return { citedKeys: rows.map(r => r.key), knownKeys: [...entries.keys()], missingKeys: rows.filter(r => r.status === 'missing-bib').map(r => r.key),
    ok: issues.length === 0 && rows.every(r => ['resolved', 'inline'].includes(r.status)), rows, issues, summary,
    scope: 'project-static: scans project TeX/Bib; no macro/conditional execution, no compilation or external source verification; bibliography links are project-wide, not proof of a particular TeX entrypoint.' };
}
