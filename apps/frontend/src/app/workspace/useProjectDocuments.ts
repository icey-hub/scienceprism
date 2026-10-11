import { useEffect, useRef, useState } from 'react';
import { getFile, getProjectTree, listProjects, writeFile, type FileItem } from '../../api/projectAdapter';
import type { FileVersion } from '../../api/client';
import { getLatexBodyInsertionRange } from '../editor/latexSnippetInsertion';
import { updateProjectDocument } from './projectDocuments';

/** Project context has no editor instance, PDF, draft, or cursor dependency. */
export function useProjectDocuments(projectId: string) {
  const [name, setName] = useState(projectId), [items, setItems] = useState<FileItem[]>([]);
  const [path, setPath] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const alive = useRef(true), writing = useRef(false);
  const refresh = async () => {
    const data = await getProjectTree(projectId);
    if (!alive.current) return;
    const files = data.items.filter(item => !/^\.(scienceprism|openprism)(\/|$)/.test(item.path));
    setItems(files);
    setPath(current => files.some(item => item.path === current) ? current : files.find(item => item.path.endsWith('main.tex'))?.path || files.find(item => item.path.endsWith('.tex'))?.path || '');
  };
  useEffect(() => {
    alive.current = true;
    Promise.all([refresh(), listProjects().then(data => { if (alive.current) setName(data.projects.find(item => item.id === projectId)?.name || projectId); })])
      .catch(cause => { if (alive.current) setError(String(cause)); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [projectId]);
  const read = async (target: string) => {
    const value = await getFile(projectId, target);
    if (!alive.current) throw new Error('页面已关闭。');
    return value;
  };
  const write = async (target: string, content: string, version: FileVersion) => {
    if (!alive.current) throw new Error('页面已关闭。');
    const result = await writeFile(projectId, target, content, version);
    if (!result.ok) throw new Error('文件未保存。');
    return result;
  };
  const perform = async (work: () => Promise<unknown>) => {
    if (writing.current) throw new Error('正在保存，请稍后再试。');
    writing.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); await refresh(); if (alive.current) setNotice('已保存到项目文件。'); }
    catch (cause) { if (alive.current) setError(String(cause)); throw cause; }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const update = (target: string, transform: (content: string) => string) => updateProjectDocument(read, write, target, transform);
  const append = async (text: string, target = path) => {
    if (!target.toLowerCase().endsWith('.tex')) throw new Error('请选择目标 TeX 文件。');
    await update(target, content => {
      const range = getLatexBodyInsertionRange(content, content.length, content.length);
      return `${content.slice(0, range.from)}\n${text.trim()}\n${content.slice(range.to)}`;
    });
  };
  const insert = async (text: string, target = path) => perform(() => append(text, target));
  const createBib = async () => {
    const target = 'references.bib';
    await perform(async () => {
      // Existing bibliography is selected, never replaced with an empty template.
      const snapshot = await read(target);
      if (!snapshot.version.exists) await write(target, '% Add BibTeX entries here\n', snapshot.version);
    });
    return target;
  };
  const versions = async () => path ? [{ ...(await read(path)).version, path }] : [];
  const clearFeedback = () => { setError(''); setNotice(''); };
  const report = (cause: unknown) => { if (alive.current) setError(String(cause)); };
  return { projectId, name, items, path, setPath, error, notice, loading, busy, alive,
    texFiles: items.filter(item => item.type === 'file' && item.path.endsWith('.tex')).map(item => item.path),
    bibFiles: items.filter(item => item.type === 'file' && item.path.endsWith('.bib')).map(item => item.path),
    refresh, read, write, update, append, insert, createBib, versions, perform, report, clearFeedback };
}
