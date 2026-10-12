import { useState } from 'react';
import { readerError, type PaperAnnotation } from '../../api/paperReaderAdapter';
import type { usePaperAnnotations } from './usePaperAnnotations';

export function ReadingNotes({ controller, hash, onLocate }: { controller: ReturnType<typeof usePaperAnnotations>; hash: string; onLocate: (page: number) => void }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = async (action: () => Promise<unknown>, clear = false) => {
    setBusy(true); setError('');
    try { await action(); if (clear) { setDraft(''); setEditing(null); } } catch (cause) { setError(readerError(cause)); } finally { setBusy(false); }
  };
  const exportNotes = () => {
    const notes = controller.data?.annotations || [];
    const content = notes.map(note => `## ${note.page ? `第 ${note.page} 页` : '未定位笔记'}\n\n${note.anchor?.quote || note.quote || ''}\n\n${note.translation?.translatedText || ''}\n\n${note.text}\n\n${note.anchor ? `PDF SHA256: ${note.anchor.fileSha256}` : ''}`).join('\n\n---\n\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'reading-notes.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="reader-notes" aria-label="阅读批注"><header><h2>批注与笔记 <span>{controller.data?.annotations.length || 0}</span></h2><button onClick={() => void change(controller.refresh)}>刷新</button><button disabled={!controller.data?.annotations.length} onClick={exportNotes}>导出</button></header>
    <label>{editing ? '编辑笔记' : '随手记'}<textarea aria-label="阅读笔记" value={draft} onChange={event => setDraft(event.target.value)} rows={3} placeholder="记录方法、不足或新的想法…" /></label><div className="reader-note-actions"><button disabled={busy || !draft.trim() || !controller.data} onClick={() => void change(() => editing ? controller.edit(editing, draft) : controller.add(draft), true)}>{busy ? '保存中…' : '保存笔记'}</button>{editing && <button onClick={() => { setDraft(''); setEditing(null); }}>取消编辑</button>}</div>
    {(error || controller.error) && <p role="alert" className="reader-error">{error || controller.error} <button onClick={() => void change(controller.refresh)}>重新读取批注</button></p>}
    {controller.data?.annotations.map(note => <Note key={note.id} note={note} active={note.anchor?.fileSha256 === hash && note.locationStatus === 'anchored'} disabled={busy} onLocate={onLocate} onEdit={() => { setEditing(note.id); setDraft(note.text); }} onRemove={() => void change(() => controller.remove(note.id))} />)}
    {!controller.data?.annotations.length && <p className="reader-muted">选中原文后可保存高亮和译文，也可以直接记录笔记。已有资料库批注会显示在这里。</p>}
  </section>;
}
function Note({ note, active, disabled, onLocate, onEdit, onRemove }: { note: PaperAnnotation; active: boolean; disabled: boolean; onLocate: (page: number) => void; onEdit: () => void; onRemove: () => void }) {
  return <article className="reader-note"><header>{active ? <button onClick={() => onLocate(note.anchor!.page)}>第 {note.anchor!.page} 页 · 返回原文</button> : <span>{note.anchor ? '来自其他附件版本' : note.page ? `第 ${note.page} 页 · 未定位` : '未定位笔记'}</span>}<small>{new Date(note.createdAt).toLocaleDateString()}</small></header>{(note.anchor?.quote || note.quote) && <blockquote>{note.anchor?.quote || note.quote}</blockquote>}{note.translation && <p>{note.translation.translatedText}<small className="reader-note-provider">{note.translation.providerId}</small></p>}{note.text && <p>{note.text}</p>}<footer><button disabled={disabled} onClick={onEdit}>编辑</button><button disabled={disabled} onClick={onRemove}>删除</button></footer></article>;
}
