import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Languages, MapPin, X } from 'lucide-react';
import { getTranslationProviders, readerError, translateSelection, type ReadingSelection, type TranslationProvider, type TranslationResult } from '../../api/paperReaderAdapter';

export function TranslationPanel({ projectId, paperId, selection, onLocate, onSave }: { projectId: string; paperId: string; selection: ReadingSelection | null; onLocate: (page: number) => void; onSave?: (selection: ReadingSelection, translation: TranslationResult | null) => Promise<void> }) {
  const [providers, setProviders] = useState<TranslationProvider[]>([]);
  const [provider, setProvider] = useState('bing-web');
  const [automatic, setAutomatic] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState('');
  const current = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void getTranslationProviders(projectId, abort.signal).then(data => { if (!abort.signal.aborted) setProviders(data.providers); }).catch(cause => { if (!abort.signal.aborted) setError(readerError(cause)); });
    return () => abort.abort();
  }, [projectId]);
  const translate = useCallback(async () => {
    if (!selection) return;
    current.current?.abort();
    const abort = new AbortController(); current.current = abort;
    setBusy(true); setError(''); setNotice(''); setResult(null);
    try { const response = await translateSelection(projectId, paperId, selection, provider, abort.signal); if (!abort.signal.aborted && response.translation.selectionId === selection.id) setResult(response.translation); }
    catch (cause) { if (!abort.signal.aborted) setError(readerError(cause)); }
    finally { if (current.current === abort && !abort.signal.aborted) { setBusy(false); current.current = null; } }
  }, [projectId, paperId, provider, selection]);
  useEffect(() => {
    current.current?.abort(); current.current = null; setBusy(false); setResult(null); setError(''); setNotice('');
    const timer = automatic && selection ? setTimeout(() => void translate(), 750) : undefined;
    return () => { clearTimeout(timer); current.current?.abort(); };
  }, [automatic, selection, translate]);
  const saveKey = `${selection?.id || ''}:${result?.translatedAt || ''}:${result?.providerId || ''}`;
  const save = async () => {
    if (!onSave || !selection || saving || savedKey === saveKey) return;
    setSaving(true);
    try { await onSave(selection, result); setSavedKey(saveKey); setNotice('已保存为带页码的批注。'); }
    catch (cause) { setError(readerError(cause)); }
    finally { setSaving(false); }
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setNotice('已复制'); } catch { setNotice('复制未成功，可以在右栏手动选择文字。'); } };
  return <section className="reader-translation" aria-label="选区翻译">
    <header><Languages size={18} /><h2>阅读助手</h2></header>
    <label className="reader-provider">翻译来源<select value={provider} onChange={event => setProvider(event.target.value)}>{providers.length ? providers.map(item => <option key={item.id} value={item.id}>{item.label}{item.health.status === 'rate-limited' ? ' · 限流中' : item.health.status === 'unavailable' ? ' · 暂不可用' : ''}</option>) : <option value="bing-web">微软 Bing · 免费网页来源</option>}</select></label>
    <label className="reader-auto"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />划选后自动翻译</label>
    <p className="reader-muted">免 Key 网页来源可能限流，可手动切换。每次最多 {providers.find(item => item.id === provider)?.maxCharacters || 1000} 字符。</p>
    {selection ? <>
      <div className="reader-selection-heading"><h3>原文</h3><button onClick={() => onLocate(selection.page)}><MapPin size={13} />第 {selection.page} 页</button><button aria-label="复制原文" onClick={() => void copy(selection.text)}><Copy size={14} /></button></div>
      <blockquote className="reader-quote">{selection.text}</blockquote>
      <div className="reader-translation-actions"><button className="reader-primary" onClick={() => void translate()} disabled={busy || Array.from(selection.text).length > (providers.find(item => item.id === provider)?.maxCharacters || 1000)}>{busy ? '正在翻译…' : '翻译选中文本'}</button>{busy && <button onClick={() => { current.current?.abort(); current.current = null; setBusy(false); setNotice('已取消翻译，原文保留。'); }}><X size={14} />取消</button>}</div>
      {result && <div className="reader-translated"><div className="reader-selection-heading"><h3>译文</h3><button aria-label="复制译文" onClick={() => void copy(result.translatedText)}><Copy size={14} /></button></div><p>{result.translatedText}</p><small>{providers.find(item => item.id === result.providerId)?.label || result.providerId}{result.cached ? ' · 来自缓存' : ''}</small></div>}
      {onSave && <button className="reader-save-note" disabled={saving || savedKey === saveKey} onClick={() => void save()}>{savedKey === saveKey ? '已保存批注' : saving ? '保存中…' : `保存${result ? '原文与译文' : '选区'}为批注`}</button>}
    </> : <div className="reader-selection-empty"><Languages size={30} strokeWidth={1.3} /><h3>选中一段，开始精读</h3><p>在 PDF 内划选原文，译文会显示在这里。原文布局保持不变。</p></div>}
    {error && <p role="alert" className="reader-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
