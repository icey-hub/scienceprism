import path from 'node:path';
import { plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';

const escaped = (text, i) => { let n = 0; while (i > 0 && text[--i] === '\\') n++; return n % 2 === 1; };
function balanced(text, start, open, close, bib = true) {
  let depth = 1, braces = 0, quoted = false;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    const atEntryLevel = open === '{' ? depth === 1 : braces === 0;
    if (bib && text[i] === '"' && atEntryLevel) { quoted = !quoted; continue; }
    if (quoted) continue;
    if (text[i] === '%' && (!bib || atEntryLevel)) { const end = text.indexOf('\n',i); i = end < 0 ? text.length : end; continue; }
    if (open === '(') {
      if (text[i] === '{') { braces++; continue; }
      if (text[i] === '}') { if (--braces < 0) throw new Error('Unbalanced BibTeX field'); continue; }
      if (braces) continue;
    }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i + 1;
  }
  throw new Error('Unclosed literal argument');
}
// Compare complete lexical fields, retaining string macro names and TeX groups.
// Expanded values depend on the surrounding @string definitions and cannot
// establish whether the original entry itself is already present.
function lexicalFingerprint(raw, kind) {
  const open = raw.search(/[({]/), comma = raw.indexOf(',',open);
  const fields = [], pieces = []; let start=comma+1, braces=0, quoted=false;
  for (let i=start;i<raw.length-1;i++) {
    const char=raw[i];
    if (char==='\\') { i++; continue; }
    if (char==='"' && braces===0) { quoted=!quoted; continue; }
    if (quoted) continue;
    if (char==='{') braces++;
    else if (char==='}') braces--;
    else if (char==='%' && braces===0) { const end=raw.indexOf('\n',i); i=end<0?raw.length:end; }
    else if (char===',' && braces===0) { pieces.push(raw.slice(start,i)); start=i+1; }
  }
  pieces.push(raw.slice(start,-1));
  for (let piece of pieces) {
    let clean='',level=0,inString=false;
    for(let i=0;i<piece.length;i++){const char=piece[i];if(char==='\\'){clean+=char+(piece[++i]||'');continue;}if(char==='"'&&level===0)inString=!inString;if(!inString){if(char==='{')level++;else if(char==='}')level--;if(char==='%'&&level===0){const end=piece.indexOf('\n',i);i=end<0?piece.length:end;clean+=' ';continue;}}clean+=char;}
    piece=clean.trim();
    if (!piece) continue;
    const match=/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([\s\S]+)$/.exec(piece);
    if (!match) throw new Error('Unsupported complete BibTeX field');
    const key=match[1].toLowerCase();
    if (fields.some(([name])=>name===key)) throw new Error('Duplicate BibTeX field');
    const value=match[2].trim(); let canonical='',depth=0,inQuote=false;
    for(let i=0;i<value.length;i++) {
      const char=value[i];
      if(char==='\\') {canonical+=char+(value[++i]||'');continue;}
      if(char==='"'&&depth===0)inQuote=!inQuote;
      if(char==='{')depth++;else if(char==='}')depth--;
      if(/\s/.test(char)&&depth===0&&!inQuote)continue;
      canonical+=char;
    }
    fields.push([key,canonical]);
  }
  return JSON.stringify([kind.toLowerCase(),fields.sort(([a],[b])=>a.localeCompare(b))]);
}
export function parseCitationBib(text) {
  const slices = []; let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
    const header = text.slice(i).match(/^@([A-Za-z]+)\s*([({])/);
    if (!header) throw new Error('Unsupported text outside BibTeX entries');
    const start = i, openAt = i + header[0].length - 1;
    i = balanced(text, openAt, header[2], header[2] === '{' ? '}' : ')');
    const kind = header[1].toLowerCase();
    if (['comment', 'string', 'preamble'].includes(kind)) continue;
    const label = text.slice(openAt + 1, i - 1).match(/^\s*([^,\s]+)\s*,/);
    if (!label || !/^[A-Za-z0-9_:./+-]{1,200}$/.test(label[1])) throw new Error('Unsupported BibTeX key');
    slices.push({ key: label[1], start, end: i, keyStart: openAt + 1 + label[0].indexOf(label[1]), raw: text.slice(start, i) });
    if (slices.length > 10000) throw new Error('Too many BibTeX entries');
  }
  const parsed = plugins.input.data(text, '@bibtex/text');
  if (parsed.length !== slices.length) throw new Error('BibTeX parser did not map every entry');
  return parsed.map((entry, index) => {
    if (entry.label !== slices[index].key) throw new Error('BibTeX source key mismatch');
    return { ...slices[index], fingerprint: lexicalFingerprint(slices[index].raw,entry.type) };
  });
}

/** Literal import/position checks only; no TeX macro evaluation or compilation. */
export function citationTexMask(source) {
  const chars = source.split(''), blocked = [];
  const mask = (start, end) => { blocked.push([start, end]); for (let j = start; j < end; j++) if (chars[j] !== '\n') chars[j] = ' '; };
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '%' && !escaped(source, i)) { const end = source.indexOf('\n', i); const to = end < 0 ? source.length : end; mask(i, to); i = to - 1; continue; }
    if (source[i] === '\\' && source[i+1] === '\\') { i++; continue; }
    if (source[i] !== '\\' || escaped(source, i)) continue;
    const literal = source.slice(i).match(/^\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/);
    if (literal) { const endToken = `\\end{${literal[1]}}`, end = source.indexOf(endToken, i + literal[0].length); if (end < 0) throw new Error('Unclosed literal environment'); const to = end + endToken.length; mask(i, to); i = to - 1; continue; }
    const verb = source.slice(i).match(/^\\verb\*?([^A-Za-z\s])/);
    if (verb) { const end = source.indexOf(verb[1], i + verb[0].length); if (end < 0 || source.slice(i, end).includes('\n')) throw new Error('Unclosed verb command'); mask(i, end + 1); i = end; continue; }
    const definition = source.slice(i).match(/^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*(?:\{\\[A-Za-z]+\}|\\[A-Za-z]+)\s*(?:\[[^\]]*\]\s*){0,2}|^\\(?:def|gdef|edef|xdef)\s*\\[A-Za-z]+[^{}]*/);
    if (definition) { const at = i + definition[0].length; if (source[at] !== '{') throw new Error('Unsupported macro definition'); const end = balanced(source, at, '{', '}', false); mask(i, end); i = end - 1; }
  }
  const text = chars.join('');
  if (/\\(?:if[A-Za-z]*|else|fi|newenvironment|renewenvironment)\b/.test(text)) throw new Error('Conditional or custom-environment TeX needs an explicit supported insertion document');
  return { text, blocked };
}
export function assertCitationOffset(source, offset, mask = citationTexMask(source)) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new Error('Insertion offset is outside the saved TeX');
  if (mask.blocked.some(([start, end]) => offset > start && offset <= end)) throw new Error('Insertion offset is inside a comment, literal or macro definition');
  if (offset > 0 && offset < source.length && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset])) throw new Error('Insertion offset splits a Unicode character');
}
export function bibliographyLinked(texPath, bibPath, text) {
  const pattern = /\\(bibliography|addbibresource)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g; let match;
  while ((match = pattern.exec(text))) {
    for (const value of (match[1] === 'bibliography' ? match[2].split(',') : [match[2]])) {
      const raw = value.trim();
      if (!raw || /[\\{}#%]|^\/|^[A-Za-z]+:/.test(raw)) continue;
      const resolved = path.posix.normalize(/\.bib$/i.test(raw) ? raw : `${raw}.bib`);
      if (!resolved.startsWith('../') && resolved === bibPath) return true;
    }
  }
  return false;
}
