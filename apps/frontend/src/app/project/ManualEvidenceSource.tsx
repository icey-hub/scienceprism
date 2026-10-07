import { useState } from 'react';
import { getEvidenceLedgerSnapshot, saveManualEvidenceSource, type ManualEvidenceSourceInput } from '../../api/client';

export function ManualEvidenceSource({ projectId, initialVersion, onSaved, onCancel }: { projectId: string; initialVersion: number; onSaved: () => void; onCancel: () => void }) {
  const [id] = useState(() => `manual-${crypto.randomUUID()}`);
  const [version, setVersion] = useState(initialVersion);
  const [draft, setDraft] = useState<ManualEvidenceSourceInput>({ title: '', summary: '', url: '', path: '', locator: '', version: '' });
  const [busy, setBusy] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const change = (field: keyof ManualEvidenceSourceInput, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  async function reload() {
    setBusy(true); setError(''); setNotice('');
    try {
      const { ledger } = await getEvidenceLedgerSnapshot(projectId);
      if (ledger.entries.some((entry) => entry.id === id)) { onSaved(); return; }
      setVersion(ledger.version); setMustReload(false); setNotice('已读取最新账本，补录草稿保留，请确认后再保存。');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || mustReload) return;
    setError(''); setNotice('');
    if (!draft.title.trim() || !draft.summary.trim()) { setError('请填写来源名称和材料说明。'); return; }
    if (draft.url.trim()) {
      try { if (!['http:', 'https:'].includes(new URL(draft.url.trim()).protocol)) throw new Error(); }
      catch { setError('来源链接必须是完整的 HTTP(S) 地址，未知可留空。'); return; }
    }
    setBusy(true);
    try { await saveManualEvidenceSource(projectId, id, draft, version); onSaved(); }
    catch (err) { setMustReload(true); setError(`补录未确认成功，草稿保留：${err instanceof Error ? err.message : String(err)}。请先读取最新账本确认是否已保存。`); }
    finally { setBusy(false); }
  }
  return <form aria-label="人工来源补录" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <p>记录手头材料的来路，或说明材料为何缺失。补录保存为未核验的人工备注，不代替原文，也不会自动关联引用或批准主张。</p>
    <fieldset disabled={busy}><legend>人工来源</legend>
      <label>来源名称<input required maxLength={500} value={draft.title} onChange={(event) => change('title', event.target.value)} /></label>
      <label>材料说明或缺失原因<textarea required rows={3} maxLength={4000} value={draft.summary} onChange={(event) => change('summary', event.target.value)} /></label>
      <label>来源链接（可选）<input type="url" maxLength={2000} value={draft.url} onChange={(event) => change('url', event.target.value)} /></label>
      <label>项目内文件路径（可选）<input maxLength={1000} value={draft.path} onChange={(event) => change('path', event.target.value)} /></label>
      <label>来源版本（未知留空）<input maxLength={500} value={draft.version} onChange={(event) => change('version', event.target.value)} /></label>
      <label>材料定位（可选）<input maxLength={500} value={draft.locator} onChange={(event) => change('locator', event.target.value)} /></label>
    </fieldset>
    <div className="claim-citation-actions"><button type="submit" disabled={busy || mustReload}>保存人工来源</button><button type="button" disabled={busy} onClick={() => void reload()}>读取最新账本（保留补录草稿）</button><button type="button" disabled={busy} onClick={onCancel}>取消补录</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </form>;
}
