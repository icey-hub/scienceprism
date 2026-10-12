import type { FileVersion } from '../../api/client';

type Snapshot = { content: string; version: FileVersion };
type Read = (path: string) => Promise<Snapshot>;
type Write = (path: string, content: string, version: FileVersion) => Promise<unknown>;

/** Read once and submit that exact version; never overwrite a concurrent edit. */
export async function updateProjectDocument(read: Read, write: Write, path: string, transform: (content: string) => string) {
  if (!path) throw new Error('请选择目标文件。');
  const snapshot = await read(path);
  const content = transform(snapshot.content);
  if (content !== snapshot.content) await write(path, content, snapshot.version);
  return content;
}

// Extract complete entries instead of treating an @ inside a title/comment as
// the next record. Keep the original source unchanged; this is not a formatter.
function bibliographyEntries(content: string) {
  const entries: { key: string; source: string; start: number; end: number }[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === '%') { while (index < content.length && content[index] !== '\n') index++; continue; }
    if (content[index] !== '@') continue;
    const head = /^@([A-Za-z]+)\s*([({])/.exec(content.slice(index));
    if (!head) continue;
    const braced = head[2] === '{';
    let depth = braced ? 1 : 0;
    let quoted = false;
    let end = index + head[0].length;
    for (; end < content.length; end++) {
      const character = content[end];
      if (character === '\\') { end++; continue; }
      if (character === '"' && depth === (braced ? 1 : 0) && head[1].toLowerCase() !== 'comment') quoted = !quoted;
      if (quoted) continue;
      if (character === '%' && depth === (braced ? 1 : 0)) { while (end < content.length && content[end] !== '\n') end++; continue; }
      if (character === '{') depth++;
      if (character === '}') { depth--; if (braced && depth === 0) break; }
      if (!braced && character === ')' && depth === 0) break;
    }
    if (end >= content.length) throw new Error('BibTeX 条目未闭合，请先修复参考文献文件。');
    const source = content.slice(index, end + 1);
    if (!/^(?:comment|string|preamble)$/i.test(head[1])) {
      const key = /^@[A-Za-z]+\s*[({]\s*([^,\s{}()]+)\s*,/.exec(source)?.[1];
      if (!key) throw new Error('来源没有可用的 BibTeX 引用键。');
      entries.push({ key, source, start: index, end: end + 1 });
    }
    index = end;
  }
  return entries;
}

function comparableBibEntry(source: string) {
  const opening = source.search(/[({]/);
  const outerDepth = source[opening] === '{' ? 1 : 0;
  let depth = 0;
  let quoted = false;
  let result = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') { result += source.slice(index, index + 2); index++; continue; }
    if (character === '"' && depth === outerDepth) quoted = !quoted;
    if (character === '%' && !quoted && depth === outerDepth) { while (index < source.length && source[index] !== '\n') index++; continue; }
    if (/\s/.test(character)) {
      // Preserve word boundaries in values: "New York" is not "NewYork".
      if ((quoted || depth > outerDepth) && !result.endsWith(' ')) result += ' ';
      continue;
    }
    if (!quoted && character === '{') depth++;
    if (!quoted && character === '}') depth--;
    result += character;
  }
  return result;
}

export function mergeBibEntries(content: string, entries: string[]) {
  const keys: string[] = [];
  const existing = bibliographyEntries(content);
  for (const entry of entries) {
    const normalized = entry.trim();
    const parsed = bibliographyEntries(normalized);
    if (parsed.length !== 1 || parsed[0].start !== 0 || parsed[0].end !== normalized.length) throw new Error('来源必须包含一条完整的 BibTeX 文献条目。');
    const candidate = parsed[0];
    const matches = existing.filter(item => item.key === candidate.key);
    if (matches.some(item => comparableBibEntry(item.source) !== comparableBibEntry(candidate.source))) {
      throw new Error(`BibTeX 引用键“${candidate.key}”已存在，但完整条目内容不同。请先核对并更换引用键；未写入或插入引用。`);
    }
    keys.push(candidate.key);
    if (!matches.length) {
      content += `${content && !content.endsWith('\n') ? '\n' : ''}${normalized}\n`;
      existing.push(candidate);
    }
  }
  return { content, keys: [...new Set(keys)] };
}
