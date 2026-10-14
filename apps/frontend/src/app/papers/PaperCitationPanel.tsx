import './PaperCitation.css';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FileVersion, PaperLibraryRecord } from '../../api/client';
import { applyManuscriptCitation, citationPositionOffset, clearPendingCitation, getManuscriptCitationRequest, loadPendingCitation, persistPendingCitation, previewManuscriptCitation, type CitationDraft, type CitationReadingSource, type ManuscriptCitationInput, type ManuscriptCitationPreview, type ManuscriptCitationResult, type PendingManuscriptCitation } from '../../api/manuscriptCitationAdapter';
import { useProjectDocuments } from '../workspace/useProjectDocuments';
import { mergeBibEntries } from '../workspace/projectDocuments';
import { useAssistantRun } from '../editor/useAssistantRun';
import { workspaceModel } from '../workspace/workspaceModel';
import { readerError } from '../../api/paperReaderAdapter';

const initialDraft: CitationDraft = { line: 1, column: 1, importKind: '', importLine: 1, importColumn: 1, includeReadingSource: true };
type RequestPhase = 'unknown' | 'not_found' | 'applying' | 'applied' | 'rolled_back' | 'recovery_required';

/** Citation writes share one source-bound transaction; optional AI suggestions remain reviewable. */
export default function PaperCitationPanel({ projectId, paper, readingSource, onClose }: { projectId: string; paper: PaperLibraryRecord; readingSource?: CitationReadingSource; onClose: () => void }) {
  const docs = useProjectDocuments(projectId), assistant = useAssistantRun(projectId);
  const [bibPath, setBibPath] = useState('');
  const [mode, setMode] = useState<'bib' | 'cite' | 'ai'>('cite');
  const [draft, setDraft] = useState<CitationDraft>(initialDraft);
  const [preview, setPreview] = useState<{ value: ManuscriptCitationPreview; input: ManuscriptCitationInput } | null>(null);
  const [pending, setPending] = useState<PendingManuscriptCitation | null>(null);
  const [phase, setPhase] = useState<RequestPhase>('unknown');
  const [receipt, setReceipt] = useState<ManuscriptCitationResult | null>(null);
  const [document, setDocument] = useState<{ path: string; content: string; version: FileVersion } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false), [sourceRefresh, setSourceRefresh] = useState(0);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [storageError, setStorageError] = useState(false);
  const lock = useRef(false), epoch = useRef(0), positionedPath = useRef(''), positionEdits = useRef(0), bibChosen = useRef(false);
  const frozen = busy || storageError || Boolean(pending && phase !== 'rolled_back');

  useEffect(() => {
    epoch.current += 1;
    try {
      const saved = loadPendingCitation(projectId, paper.id);
      if (saved) {
        bibChosen.current = true; setPending(saved); setBibPath(saved.input.bibPath); docs.setPath(saved.input.texPath); setDraft(saved.draft);
        void recover(saved);
      }
    } catch (cause) { setStorageError(true); setStatus(readerError(cause)); }
    return () => { epoch.current += 1; lock.current = false; };
  }, [projectId, paper.id]);
  useEffect(() => { if (!bibChosen.current && docs.bibFiles.length) { bibChosen.current = true; setBibPath(docs.bibFiles[0]); } }, [docs.bibFiles]);
  useEffect(() => { setPreview(null); }, [bibPath, docs.path, draft, mode, readingSource, sourceRefresh]);
  useEffect(() => {
    if (!docs.path) return;
    let cancelled = false;
    const edits = positionEdits.current;
    setSourceLoading(true); setDocument(null);
    docs.read(docs.path).then(value => {
      if (cancelled) return;
      setDocument({ path: docs.path, ...value });
      if (!pending && positionedPath.current !== docs.path && positionEdits.current === edits) {
        const end = /\\end\s*\{\s*document\s*\}/.exec(value.content)?.index ?? -1;
        const offset = end >= 0 ? end : value.content.length;
        const lines = value.content.slice(0, offset).split('\n'), line = lines.length, column = lines.at(-1)!.length + 1;
        setDraft(current => ({ ...current, line, column, importLine: line, importColumn: column }));
      }
      positionedPath.current = docs.path;
    }).catch(cause => { if (!cancelled) setStatus(readerError(cause)); }).finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [docs.path, projectId, sourceRefresh]);

  async function recover(saved = pending) {
    if (!saved || lock.current) return;
    const currentEpoch = epoch.current;
    lock.current = true; setBusy(true);
    try {
      const value = await getManuscriptCitationRequest(projectId, saved.input.requestId);
      if (!docs.alive.current || currentEpoch !== epoch.current) return;
      if (value.requestId !== saved.input.requestId || value.source.paperId !== saved.paperId || value.source.paperRevision !== saved.input.expectedPaperRevision || (value.receipt && (value.receipt.source.paperId !== saved.paperId || value.receipt.tex.path !== saved.input.texPath || value.receipt.bib.path !== saved.input.bibPath))) throw new Error('原请求回执与论文或写入目标不一致，请保留恢复记录。');
      setPhase(value.status); setReceipt(value.receipt);
      setStatus(value.status === 'applied' ? '引用已保存，文稿、Bib 与来源记录已同步。' : value.status === 'rolled_back' ? '本次写入已回滚，草稿保留。可修改位置并重新预览。' : value.status === 'recovery_required' ? '部分文件已有更新，需要先处理原请求恢复，不能新建写入。' : '原请求仍在处理中，请稍后检查状态。');
    } catch (cause) {
      if (!docs.alive.current || currentEpoch !== epoch.current) return;
      if ((cause as { code?: string })?.code === 'CITATION_REQUEST_NOT_FOUND') {
        setPhase('not_found'); setStatus('服务器未找到原请求。可用相同请求编号与内容重试。');
      } else { setPhase('unknown'); setStatus(`写入状态尚未确认：${readerError(cause)}。请检查原请求，勿重复新建。`); }
    } finally { if (currentEpoch === epoch.current) { lock.current = false; if (docs.alive.current) setBusy(false); } }
  }

  async function createPreview() {
    if (lock.current || storageError || !document || document.path !== docs.path || sourceLoading || (pending && phase !== 'rolled_back')) return;
    lock.current = true; setBusy(true); setStatus(''); setPreview(null);
    const currentEpoch = epoch.current;
    try {
      if (pending) { clearPendingCitation(projectId, paper.id); setPending(null); }
      const tex = document, target = bibPath || 'references.bib';
      const bib = docs.items.some(item => item.path === target) ? await docs.read(target) : { content: '', version: { exists: false, sha256: null } };
      const input: ManuscriptCitationInput = {
        paperId: paper.id, texPath: docs.path, bibPath: target,
        expectedTexVersion: tex.version, expectedBibVersion: bib.version,
        position: { offset: citationPositionOffset(tex.content, draft.line, draft.column) },
        ...(draft.citationKey?.trim() ? { citationKey: draft.citationKey.trim() } : {}),
        ...(readingSource && draft.includeReadingSource ? { readingSource } : {}),
        ...(draft.importKind ? { bibliographyImport: { kind: draft.importKind, offset: citationPositionOffset(tex.content, draft.importLine, draft.importColumn) } } : {}),
      };
      const value = await previewManuscriptCitation(projectId, input);
      if (docs.alive.current && currentEpoch === epoch.current) { setPreview({ value, input }); setStatus('预览完成，尚未修改项目文件。'); }
    } catch (cause) { if (docs.alive.current && currentEpoch === epoch.current) setStatus(readerError(cause)); }
    finally { if (currentEpoch === epoch.current) { lock.current = false; if (docs.alive.current) setBusy(false); } }
  }

  async function submit(saved: PendingManuscriptCitation) {
    if (lock.current) return;
    const currentEpoch = epoch.current;
    lock.current = true; setBusy(true); setStatus('正在保存引用…');
    try {
      const value = await applyManuscriptCitation(projectId, saved.input);
      if (docs.alive.current && currentEpoch === epoch.current) {
        setReceipt(value); setPhase('applied'); setStatus('引用已保存，文稿、Bib 与来源记录已同步。');
        docs.refresh().catch(cause => { if (docs.alive.current && currentEpoch === epoch.current) setStatus(`引用已保存；文件列表刷新失败：${readerError(cause)}`); });
      }
    } catch (cause) {
      if (docs.alive.current && currentEpoch === epoch.current) { setPhase('unknown'); setStatus(`保存结果需要确认：${readerError(cause)}。原请求与草稿已保留。`); }
    } finally { if (currentEpoch === epoch.current) { lock.current = false; if (docs.alive.current) setBusy(false); } }
  }
  function saveCitation() {
    if (!preview || lock.current || pending || storageError || !preview.value.bibliographyLinked) return;
    const saved: PendingManuscriptCitation = { projectId, paperId: paper.id, draft, input: { ...preview.input, requestId: crypto.randomUUID(), expectedPaperRevision: preview.value.source.paperRevision } };
    try { persistPendingCitation(saved); setPending(saved); setPhase('unknown'); void submit(saved); }
    catch (cause) { setStorageError(true); setStatus(`引用尚未写入：${readerError(cause)}`); }
  }
  function newCitation() {
    if (!pending || !['applied','rolled_back'].includes(phase) || busy) return;
    try { clearPendingCitation(projectId, paper.id); setPending(null); setReceipt(null); setPreview(null); setSourceRefresh(value => value + 1); setStatus('请重新预览下一处引用。'); }
    catch (cause) { setStorageError(true); setStatus(readerError(cause)); }
  }
  async function saveSeparateBibliography() {
    if (lock.current || pending || storageError) return;
    lock.current = true; setBusy(true); setStatus(''); let bibSaved = false;
    try {
      if (!paper.bibtex.trim()) throw new Error('这篇论文暂缺 BibTeX，请先完善文献记录。');
      const target = bibPath || await docs.createBib(); setBibPath(target); let keys: string[] = [];
      await docs.perform(() => docs.update(target, content => { const merged = mergeBibEntries(content, [paper.bibtex]); keys = merged.keys; return merged.content; }));
      bibSaved = true;
      if (mode === 'ai') {
        const started = await assistant.start({ task: 'insert_citations', prompt: `Insert a citation using \\cite{${keys.join(',')}} into ${docs.path}, only where this paper supports the text. Keep edits minimal. Paper metadata: ${JSON.stringify({ title: paper.title, abstract: paper.abstract, doi: paper.doi, arxivId: paper.arxivId })}`, permission: 'edit', activePath: docs.path, llmConfig: workspaceModel('search'), history: assistant.history }, async () => [{ path: docs.path, ...(await docs.read(docs.path)).version }]);
        if (!started) throw new Error(assistant.error || '引用建议未启动。');
      }
      if (docs.alive.current) setStatus(mode === 'ai' ? 'Bib 已保存，AI 引用建议进入项目对话，需单独审阅应用。' : 'Bib 已保存，尚未向正文插入引用。');
    } catch (cause) { if (docs.alive.current) setStatus(`${bibSaved ? 'Bib 已保存；引用建议未完成：' : ''}${readerError(cause)}`); }
    finally { lock.current = false; if (docs.alive.current) setBusy(false); }
  }

  const changeDraft = (update: Partial<CitationDraft>) => { positionEdits.current += 1; setDraft(value => ({ ...value, ...update })); };
  const source = receipt?.source.readingSource;
  const editorQuery = receipt ? new URLSearchParams({ file: receipt.tex.path, version: receipt.tex.version.sha256 || '', from: String(receipt.tex.from), to: String(receipt.tex.to), line: String(receipt.tex.line) }) : null;
  return <section className="paper-citation-panel" aria-label="引用论文" aria-busy={busy}>
    <header><div><h2>引用这篇论文</h2><p className="paper-citation-title">{paper.title}</p></div><button onClick={onClose} disabled={busy}>关闭</button></header>
    <fieldset disabled={frozen} className="paper-citation-fields"><legend>写入目标</legend>
      <label>写入方式<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="cite">文稿引用 · Bib · 来源一起保存</option><option value="bib">仅加入参考文献</option><option value="ai">由 AI 提议引用位置</option></select></label>
      <label>Bib 文件<select value={bibPath} onChange={event => { bibChosen.current = true; setBibPath(event.target.value); }}><option value="">{docs.bibFiles.includes('references.bib') ? '使用 references.bib' : '新建 references.bib（保存时创建）'}</option>{docs.bibFiles.map(path => <option key={path}>{path}</option>)}</select></label>
      {mode !== 'bib' && <label>目标文稿<select value={docs.path} onChange={event => docs.setPath(event.target.value)}>{!docs.texFiles.length && <option value="">项目暂无 TeX 文稿</option>}{docs.texFiles.map(path => <option key={path}>{path}</option>)}</select></label>}
    </fieldset>
    {mode === 'cite' && <>
      <details className="paper-citation-source" open><summary>{docs.path || '目标文稿'} · 当前保存的原稿</summary>{sourceLoading ? <p>正在读取原稿…</p> : document && <pre>{document.content.split('\n').map((value, index) => `${String(index + 1).padStart(4)} │ ${value}`).join('\n')}</pre>}<button disabled={frozen || sourceLoading || !docs.path} onClick={() => { void docs.refresh().then(() => setSourceRefresh(value => value + 1)).catch(cause => setStatus(readerError(cause))); }}>刷新原稿</button><p>插入位置按这份原稿与版本计算；版本冲突时刷新原稿再预览，保留已选行列。</p></details>
      <fieldset disabled={frozen} className="paper-citation-position"><legend>正文插入位置</legend><label>行<input type="number" min="1" step="1" value={draft.line} onChange={event => changeDraft({ line: Number(event.target.value) })} /></label><label>列<input type="number" min="1" step="1" value={draft.column} onChange={event => changeDraft({ column: Number(event.target.value) })} /></label><label>引用键（可选）<input type="text" value={draft.citationKey || ''} placeholder="沿用文献记录的键" onChange={event => changeDraft({ citationKey: event.target.value })} /></label><p>从 1 开始计数，在所选位置前插入引用。初次默认在正文末尾。</p></fieldset>
      <fieldset disabled={frozen} className="paper-citation-import"><legend>文稿接入 Bib</legend><label>导入方式<select value={draft.importKind} onChange={event => changeDraft({ importKind: event.target.value as CitationDraft['importKind'], ...(event.target.value === 'biblatex' ? (() => { const offset = /\\begin\s*\{\s*document\s*\}/.exec(document?.content || '')?.index ?? 0; const lines = (document?.content || '').slice(0, offset).split('\n'); return { importLine: lines.length, importColumn: lines.at(-1)!.length + 1 }; })() : event.target.value === 'bibtex' ? { importLine: draft.line, importColumn: draft.column } : {}) })}><option value="">使用文稿已有导入命令</option><option value="bibtex">插入 \bibliography 命令</option><option value="biblatex">插入 \addbibresource 命令</option></select></label>{draft.importKind && <><label>导入命令行<input type="number" min="1" step="1" value={draft.importLine} onChange={event => changeDraft({ importLine: Number(event.target.value) })} /></label><label>列<input type="number" min="1" step="1" value={draft.importColumn} onChange={event => changeDraft({ importColumn: Number(event.target.value) })} /></label></>}<p>仅插入所选命令，请为 biblatex 选择导言区位置；所需宏包与样式沿用文稿配置。</p></fieldset>
      {readingSource && <label className="paper-citation-reading"><input type="checkbox" checked={draft.includeReadingSource} disabled={frozen} onChange={event => changeDraft({ includeReadingSource: event.target.checked })} />附 PDF 第 {readingSource.page} 页{readingSource.selectionId ? '及保存的批注' : '来源'}（不勾选则仅记录论文元数据）</label>}
      {preview && <div className="paper-citation-preview"><header><strong>写入预览 · \cite{'{'}{preview.value.citationKey}{'}'}</strong><span>{preview.value.bibliographyLinked ? '已接入 Bib' : 'Bib 未接入，需选择导入命令并重新预览'}</span></header>{preview.value.importPreview && <p>新增命令：<code>{preview.value.importPreview.text}</code>（字符位置 {preview.value.importPreview.offset}）</p>}<details open><summary>{preview.input.texPath} · 保存后内容</summary><pre>{preview.value.texPreview}</pre></details><details><summary>{preview.input.bibPath} · 使用的 Bib 条目</summary><pre>{preview.value.bibEntry}</pre></details><p>来源记录为未核验；论文与文稿版本在保存时再次检查。</p></div>}
    </>}
    {mode === 'ai' && <p className="paper-citation-note">先单独保存 Bib，再由 AI 提议正文引用；建议需要在项目对话中审阅，不属于一次保存。</p>}
    <div className="paper-citation-actions">
      {mode === 'cite' ? <><button disabled={busy || storageError || docs.loading || sourceLoading || !document || document.path !== docs.path || Boolean(pending && phase !== 'rolled_back')} onClick={() => void createPreview()}>预览插入</button><button className="paper-citation-primary" disabled={busy || storageError || Boolean(pending) || !preview?.value.bibliographyLinked} onClick={saveCitation}>一起保存</button></> : <button disabled={frozen || Boolean(pending) || docs.loading || (mode === 'ai' && !docs.path)} onClick={() => void saveSeparateBibliography()}>{mode === 'ai' ? '保存 Bib 并生成建议' : '保存 Bib'}</button>}
      {pending && phase !== 'applied' && <button disabled={busy} onClick={() => void recover()}>检查原请求</button>}
      {pending && phase === 'not_found' && <button disabled={busy || storageError} onClick={() => void submit(pending)}>以原请求重试</button>}
      {pending && (phase === 'applying' || phase === 'recovery_required') && <button disabled={busy || storageError} onClick={() => void submit(pending)}>以原请求恢复</button>}
      {pending && (phase === 'applied' || phase === 'rolled_back') && <button disabled={busy || storageError} onClick={newCitation}>{phase === 'rolled_back' ? '使用当前草稿继续' : '新增下一处引用'}</button>}
    </div>
    {(status || docs.error || assistant.error) && <p className="paper-citation-status" role="status">{status || docs.error || assistant.error}</p>}
    {pending && <p className="paper-citation-request">请求编号：{pending.input.requestId}{phase !== 'applied' && phase !== 'rolled_back' ? ' · 已保留完整请求，等待确认结果' : ''}</p>}
    {receipt && <div className="paper-citation-receipt"><Link to={`/editor/${encodeURIComponent(projectId)}?${editorQuery}`}>打开文稿第 {receipt.tex.line} 行引用</Link><span>来源：{receipt.source.verificationStatus === 'verified' ? '已核验' : '未核验'}</span>{source && <Link to={`/project/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paper.id)}/read?${new URLSearchParams({ attachment: source.attachmentId, page: String(source.page), ...(source.selectionId ? { annotation: source.selectionId } : {}) })}`}>返回来源 PDF 第 {source.page} 页{source.selectionId ? '批注' : ''}</Link>}</div>}
    {mode === 'ai' && <Link to={`/project/${encodeURIComponent(projectId)}/chat`}>到项目对话审阅引用修改</Link>}
  </section>;
}
