import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Languages, MapPin, RefreshCw, X } from 'lucide-react';
import { clearTranslationCache, getTranslationProviders, readerError, saveTranslationSettings, translateSelection, type ReadingSelection, type TranslationResult } from '../../api/paperReaderAdapter';
import { createReaderTranslation, emptyTranslationState } from './translationRequests';

const languageNames: Record<string, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', it: 'Italiano', ar: 'العربية' };
const healthNames: Record<string, string> = { unknown: '尚未验证', available: '最近请求成功', 'rate-limited': '限流中', unavailable: '最近请求失败' };
export function TranslationPanel({ projectId, paperId, selection, onLocate, onSave }: { projectId: string; paperId: string; selection: ReadingSelection | null; onLocate: (page: number) => void; onSave?: (selection: ReadingSelection, translation: TranslationResult | null) => Promise<void> }) {
  const [state, setState] = useState(emptyTranslationState);
  const [notice, setNotice] = useState('');
  const [noteError, setNoteError] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [savedKey, setSavedKey] = useState('');
  const requests = useMemo(() => createReaderTranslation({
    load: signal => getTranslationProviders(projectId, signal),
    save: (revision, patch, signal) => saveTranslationSettings(projectId, revision, patch, signal),
    clear: signal => clearTranslationCache(projectId, signal),
    translate: (selected, provider, target, operationId, signal) => translateSelection(projectId, paperId, selected, provider, target, operationId, signal)
  }, setState), [projectId, paperId]);
  useEffect(() => { requests.activate(); void requests.refresh(); return () => requests.dispose(); }, [requests]);
  useEffect(() => { requests.select(selection); setNotice(''); setNoteError(''); }, [requests, selection]);
  const config = state.configuration, settings = config?.settings;
  const autoAttempt = useRef('');
  const autoKey = selection && settings ? JSON.stringify([projectId, paperId, selection.id, settings.defaultProviderId, settings.targetLanguage]) : '';
  useEffect(() => {
    if (!settings?.automatic) { autoAttempt.current = ''; return; }
    if (!selection || state.writing || autoAttempt.current === autoKey) return;
    const timer = setTimeout(() => { if (autoAttempt.current !== autoKey) { autoAttempt.current = autoKey; void requests.translate(); } }, 750);
    return () => clearTimeout(timer);
  }, [requests, selection, settings?.automatic, autoKey, state.writing]);
  const provider = config?.providers.find(item => item.id === settings?.defaultProviderId);
  const result = state.result;
  const locked = state.writing || !config;
  const saveKey = `${selection?.id || ''}:${result?.translatedAt || ''}:${result?.providerId || ''}`;
  const saveNote = async () => {
    if (!onSave || !selection || savingNote || savedKey === saveKey) return;
    setSavingNote(true); setNoteError('');
    try { await onSave(selection, result); setSavedKey(saveKey); setNotice('已保存为带页码的批注。'); }
    catch (cause) { setNoteError(readerError(cause)); }
    finally { setSavingNote(false); }
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setNotice('已复制'); } catch { setNotice('复制未成功，可以在右栏手动选择文字。'); } };
  return <section className="reader-translation" aria-label="选区翻译">
    <header><Languages size={18} /><h2>阅读助手</h2><button aria-label="重新读取翻译设置和用量" disabled={state.loading || state.writing} onClick={() => void requests.refresh(true)}><RefreshCw size={14} /></button></header>
    {state.loading && !config && <p role="status" className="reader-muted">正在读取项目翻译设置…</p>}
    <label className="reader-provider">翻译来源<select value={settings?.defaultProviderId || ''} disabled={locked} onChange={event => void requests.save({ defaultProviderId: event.target.value })}>{config ? config.providers.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.label} · {item.mode === 'web-free' ? '免 Key 网页' : '官方 API'}</option>) : <option value="">等待读取来源</option>}</select></label>
    {provider && <p className="reader-source-status">{healthNames[provider.health.status] || provider.health.status}{provider.health.retryAfter ? ` · 约 ${provider.health.retryAfter} 秒后重试` : ''}<span>每次最多 {provider.maxCharacters} 字符</span></p>}
    <label className="reader-provider">译文语言<select value={settings?.targetLanguage || ''} disabled={locked} onChange={event => void requests.save({ targetLanguage: event.target.value })}>{provider ? provider.targetLanguages.map(language => <option key={language} value={language}>{languageNames[language] || language}</option>) : <option value="">等待读取语言</option>}</select></label>
    <label className="reader-auto"><input type="checkbox" checked={settings?.automatic || false} disabled={locked} onChange={event => void requests.save({ automatic: event.target.checked })} />划选后自动翻译</label>
    <p className="reader-muted">网页来源可能限流，可主动切换。来源与阅读设置随项目保存。</p>
    {config && <details className="reader-translation-settings"><summary>用量与缓存</summary>
      <dl className="reader-translation-usage"><div><dt>本月已用</dt><dd>{config.usage.usedCharacters.toLocaleString()} 字符</dd></div><div><dt>发送预留</dt><dd>{config.usage.reservedCharacters.toLocaleString()} 字符</dd></div><div><dt>剩余额度</dt><dd>{config.usage.remainingCharacters === null ? '未设置上限' : `${config.usage.remainingCharacters.toLocaleString()} 字符`}</dd></div></dl>
      <p className="reader-muted">{config.usage.period}（UTC）· 应用估算，供应商账单另计。{config.usage.uncertainCharacters > 0 && `其中 ${config.usage.uncertainCharacters.toLocaleString()} 字符的结果不确定，仍保留额度。`}</p>
      <form key={config.revision} onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void requests.save({ monthlyCharacterLimit: String(data.get('limit')).trim() === '' ? null : Number(data.get('limit')), cache: { enabled: data.get('cache') === 'on', ttlMs: Number(data.get('ttl')) * 60000, maxEntries: Number(data.get('entries')) } });
      }}>
        <fieldset disabled={locked}><label className="reader-provider">每月字符上限<input name="limit" type="number" min="0" step="1" max={1000000000} placeholder="留空不设置上限" defaultValue={settings?.monthlyCharacterLimit ?? ''} /></label>
        <label className="reader-auto"><input type="checkbox" name="cache" defaultChecked={settings?.cache.enabled} />复用翻译缓存</label>
        <div className="reader-cache-fields"><label className="reader-provider">保留分钟<input name="ttl" type="number" min={1 / 60} max="1440" step={1 / 60} required defaultValue={(settings?.cache.ttlMs || 1800000) / 60000} /></label><label className="reader-provider">最多条数<input name="entries" type="number" min="1" max="2000" step="1" required defaultValue={settings?.cache.maxEntries} /></label></div>
        <button type="submit">{state.writing ? '保存中…' : '保存用量设置'}</button></fieldset>
      </form>
      <button disabled={locked} onClick={() => { autoAttempt.current = autoKey; void requests.clear(); }}>清除翻译缓存</button><p className="reader-muted">请求记录会保留，批注和原文不受影响。不会自动转用收费来源。</p>
    </details>}
    {selection ? <>
      <div className="reader-selection-heading"><h3>原文</h3><button onClick={() => onLocate(selection.page)}><MapPin size={13} />第 {selection.page} 页</button><button aria-label="复制原文" onClick={() => void copy(selection.text)}><Copy size={14} /></button></div>
      <blockquote className="reader-quote">{selection.text}</blockquote>
      <div className="reader-translation-actions"><button className="reader-primary" onClick={() => void requests.translate()} disabled={locked || state.busy || !provider?.configured || Array.from(selection.text).length > (provider?.maxCharacters || 1000)}>{state.busy ? '正在翻译…' : state.error ? '再次尝试同一请求' : '翻译选中文本'}</button>{state.busy && <button onClick={() => { autoAttempt.current = autoKey; requests.cancel(); }}><X size={14} />取消</button>}</div>
      {state.error && state.errorCode !== 'TRANSLATION_SETTINGS_CONFLICT' && <div className="reader-new-request"><p className="reader-muted">新请求可能再次消耗额度，不会撤销上次预留。</p><button disabled={locked || state.busy} onClick={() => void requests.translate(true)}>新建翻译请求</button></div>}
      {result && <div className="reader-translated"><div className="reader-selection-heading"><h3>译文</h3><button aria-label="复制译文" onClick={() => void copy(result.translatedText)}><Copy size={14} /></button></div><p>{result.translatedText}</p><small>{config?.providers.find(item => item.id === result.providerId)?.label || result.providerId} · {languageNames[result.targetLanguage || 'zh-CN'] || result.targetLanguage}{result.cached ? ' · 来自缓存' : ''}</small></div>}
      {onSave && <button className="reader-save-note" disabled={savingNote || savedKey === saveKey} onClick={() => void saveNote()}>{savedKey === saveKey ? '已保存批注' : savingNote ? '保存中…' : `保存${result ? '原文与译文' : '选区'}为批注`}</button>}
    </> : <div className="reader-selection-empty"><Languages size={30} strokeWidth={1.3} /><h3>选中一段，开始精读</h3><p>在 PDF 内划选原文，译文会显示在这里。原文布局保持不变。</p></div>}
    {(state.error || noteError) && <p role="alert" className="reader-error">{noteError || state.error}</p>}{state.notice && <p role="status" className="reader-muted">{state.notice}</p>}{notice && <p role="status" className="reader-muted">{notice}</p>}
  </section>;
}
