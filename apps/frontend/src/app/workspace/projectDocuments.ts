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

export function mergeBibEntries(content: string, entries: string[]) {
  const keys: string[] = [];
  for (const entry of entries) {
    const normalized = entry.replace(/\\n/g, '\n').trim();
    const key = /^@\w+\s*\{\s*([^,\s]+)/.exec(normalized)?.[1];
    if (!key) throw new Error('来源没有可用的 BibTeX 引用键。');
    keys.push(key);
    const existing = [...content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].some(match => match[1] === key);
    if (!existing) content += `${content && !content.endsWith('\n') ? '\n' : ''}${normalized}\n`;
  }
  return { content, keys: [...new Set(keys)] };
}
