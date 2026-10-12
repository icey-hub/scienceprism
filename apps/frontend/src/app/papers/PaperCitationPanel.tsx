import './PaperCitation.css';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PaperLibraryRecord } from '../../api/client';
import { useProjectDocuments } from '../workspace/useProjectDocuments';
import { mergeBibEntries } from '../workspace/projectDocuments';
import { useAssistantRun } from '../editor/useAssistantRun';
import { workspaceModel } from '../workspace/workspaceModel';
import { readerError } from '../../api/paperReaderAdapter';

/** Mounted only after choosing Cite; search/reading never require a manuscript. */
export default function PaperCitationPanel({ projectId, paper, onClose }: { projectId: string; paper: PaperLibraryRecord; onClose: () => void }) {
  const docs = useProjectDocuments(projectId);
  const assistant = useAssistantRun(projectId);
  const [bibPath, setBibPath] = useState('');
  const [mode, setMode] = useState<'bib' | 'cite' | 'ai'>('bib');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const lock = useRef(false);
  useEffect(() => { if (!bibPath && docs.bibFiles.length) setBibPath(docs.bibFiles[0]); }, [bibPath, docs.bibFiles]);
  const apply = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setStatus('');
    let bibSaved = false;
    try {
      if (!paper.bibtex.trim()) throw new Error('这篇论文暂缺 BibTeX，请先完善文献记录。');
      const target = bibPath || await docs.createBib(); setBibPath(target);
      let keys: string[] = [];
      await docs.perform(() => docs.update(target, content => { const merged = mergeBibEntries(content, [paper.bibtex]); keys = merged.keys; return merged.content; }));
      bibSaved = true;
      if (mode === 'cite') await docs.insert(`\\cite{${keys.join(',')}}`);
      if (mode === 'ai') {
        const started = await assistant.start({ task: 'insert_citations', prompt: `Insert a citation using \\cite{${keys.join(',')}} into ${docs.path}, only where this paper supports the text. Keep edits minimal. Paper metadata: ${JSON.stringify({ title: paper.title, abstract: paper.abstract, doi: paper.doi, arxivId: paper.arxivId })}`, permission: 'edit', activePath: docs.path, llmConfig: workspaceModel('search'), history: assistant.history }, async () => [{ path: docs.path, ...(await docs.read(docs.path)).version }]);
        if (!started) throw new Error(assistant.error || '引用建议未启动。');
      }
      if (docs.alive.current) setStatus(mode === 'ai' ? 'Bib 已保存，引用修改会进入项目对话供审阅。' : mode === 'cite' ? 'Bib 与引用已保存。' : 'Bib 已保存，原有条目保留。');
    } catch (cause) { if (docs.alive.current) setStatus(`${bibSaved ? 'Bib 已保存；后续操作未完成：' : ''}${readerError(cause)}`); }
    finally { lock.current = false; if (docs.alive.current) setBusy(false); }
  };
  return <section className="paper-citation-panel" aria-label="引用论文"><header><h2>引用这篇论文</h2><button onClick={onClose} disabled={busy}>关闭</button></header><p>{paper.title}</p><label>Bib 文件<select value={bibPath} onChange={event => setBibPath(event.target.value)}><option value="">创建或使用 references.bib</option>{docs.bibFiles.map(path => <option key={path}>{path}</option>)}</select></label><label>写入方式<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="bib">仅加入参考文献</option><option value="cite" disabled={!docs.texFiles.length}>同时在文稿末尾插入引用</option><option value="ai" disabled={!docs.texFiles.length}>由 AI 提议引用位置</option></select></label>{mode !== 'bib' && <label>目标文稿<select value={docs.path} onChange={event => docs.setPath(event.target.value)}>{docs.texFiles.map(path => <option key={path}>{path}</option>)}</select></label>}<button disabled={busy || docs.loading || (mode !== 'bib' && !docs.path)} onClick={() => void apply()}>{busy ? '处理中…' : '保存引用'}</button>{(status || docs.error || assistant.error) && <p role="status">{status || docs.error || assistant.error}</p>}{mode === 'ai' && <Link to={`/project/${encodeURIComponent(projectId)}/chat`}>到项目对话审阅引用修改</Link>}</section>;
}
