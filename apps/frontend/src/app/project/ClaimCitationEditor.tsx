import { useState } from 'react';
import { getEvidenceLedgerSnapshot, saveClaimCitations, type EvidenceCitationInput, type EvidenceLedgerSnapshot } from '../../api/client';
import { ManualEvidenceSource } from './ManualEvidenceSource';
import './ClaimMaterials.css';

type Draft = EvidenceCitationInput & { reviewed: boolean };
const emptyCitation = (): Draft => ({ evidenceId: '', sourceVersion: '', excerpt: '', section: '', page: '', locator: '', reviewed: false });
const versionOf = (entry: EvidenceLedgerSnapshot['entries'][number]) => entry.version || entry.sha256 || entry.updatedAt;

export function ClaimCitationEditor({ projectId, claimId, onSaved }: { projectId: string; claimId: string; onSaved: () => void }) {
  const [snapshot, setSnapshot] = useState<EvidenceLedgerSnapshot | null>(null);
  const [original, setOriginal] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [sourceNotice, setSourceNotice] = useState('');
  async function load(keepDraft = false) {
    setBusy(true); setError(''); setNotice('');
    try {
      const { ledger } = await getEvidenceLedgerSnapshot(projectId);
      const claim = ledger.entries.find((entry) => entry.id === claimId && entry.kind === 'paper-claim');
      if (!claim) throw new Error('当前主张已不存在，请重新打开证据页。');
      if (keepDraft && JSON.stringify(claim) !== original) {
        setBlocked(true);
        throw new Error('主张已被其他操作修改。草稿仍保留；请复制需要的文本，取消后重新编辑，以免覆盖他人的更正。');
      }
      setSnapshot(ledger); setOriginal(JSON.stringify(claim)); setBlocked(false);
      if (keepDraft) {
        setDrafts((rows) => rows.map((row) => ({ ...row, reviewed: false })));
        setNotice('已读取最新材料，草稿保留。请重新逐条核对来源并勾选复核。');
      } else setDrafts((claim.citations || []).map(({ evidenceId, sourceVersion, excerpt, section, page, locator }) => ({ evidenceId, sourceVersion, excerpt, section, page, locator, reviewed: false })));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  function change(index: number, patch: Partial<Draft>) {
    setDrafts((rows) => rows.map((row, i) => i === index ? { ...row, ...patch, reviewed: false } : row));
  }
  async function save() {
    if (!snapshot || blocked || drafts.some((row) => !row.reviewed)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await saveClaimCitations(projectId, claimId, drafts.map(({ reviewed: _reviewed, ...input }) => input), snapshot.version);
      setSnapshot(null); setDrafts([]); setNotice('人工引用已保存，未自动确认科学结论。'); onSaved();
    } catch (err) {
      setError(`保存失败，草稿已保留：${err instanceof Error ? err.message : String(err)}。如材料有更新，请重新读取材料。`);
    } finally { setBusy(false); }
  }
  const sources = snapshot?.entries.filter((entry) => entry.id !== claimId) || [];
  return <div className="claim-citation-editor">
    {!snapshot ? <button type="button" disabled={busy} onClick={() => void load()}>编辑人工引用</button> : <form onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="人工引用录入">
      <p>对照原文填写片段或位置，未知页码留空。保存会替换本主张的全部人工引用；已有 Evidence 关联保留。</p>
      <fieldset disabled={busy || addingSource}><legend>人工引用（{drafts.length}/100）</legend>
        {drafts.map((row, index) => {
          const source = sources.find((entry) => entry.id === row.evidenceId);
          return <fieldset key={index} className="claim-material-card"><legend>引用 {index + 1}</legend>
            <label>来源<select required value={row.evidenceId} onChange={(event) => change(index, { evidenceId: event.target.value, sourceVersion: '' })}><option value="">请选择来源</option>{row.evidenceId && !source && <option value={row.evidenceId}>来源缺失：{row.evidenceId}</option>}{sources.map((entry) => <option value={entry.id} key={entry.id}>{entry.title || entry.id}</option>)}</select></label>
            {source && <div><p>{source.summary || '未记录摘要'}</p><p>当前版本：{versionOf(source)}</p><p>来源：{source.source?.url || source.source?.path || '未记录'} · 定位：{source.source?.locator || '未记录'}</p></div>}
            <p>引用绑定版本：{row.sourceVersion || '尚未复核'}</p>
            <label>引用片段<textarea rows={3} maxLength={4000} value={row.excerpt} onChange={(event) => change(index, { excerpt: event.target.value })} /></label>
            <label>章节<input maxLength={500} value={row.section} onChange={(event) => change(index, { section: event.target.value })} /></label>
            <label>页码（未知留空）<input maxLength={100} value={row.page} onChange={(event) => change(index, { page: event.target.value })} /></label>
            <label>其他定位<input maxLength={500} value={row.locator} onChange={(event) => change(index, { locator: event.target.value })} /></label>
            <label className="claim-citation-check"><input type="checkbox" checked={row.reviewed} disabled={!source} onChange={(event) => setDrafts((rows) => rows.map((draft, i) => i === index ? { ...draft, reviewed: event.target.checked, sourceVersion: event.target.checked && source ? versionOf(source) : draft.sourceVersion } : draft))} />我已对照当前来源核对这条引用</label>
            <button type="button" onClick={() => setDrafts((rows) => rows.filter((_, i) => i !== index))}>移除此引用</button>
          </fieldset>;
        })}
        <button type="button" disabled={drafts.length >= 100} onClick={() => setDrafts((rows) => [...rows, emptyCitation()])}>添加引用</button>
      </fieldset>
      <div className="claim-citation-actions"><button type="submit" disabled={busy || addingSource || blocked || drafts.some((row) => !row.reviewed || ![row.excerpt, row.section, row.page, row.locator].some((text) => text.trim()))}>保存人工引用</button><button type="button" disabled={busy || addingSource} onClick={() => void load(true)}>重新读取材料（保留草稿）</button><button type="button" disabled={busy || addingSource} onClick={() => { setSnapshot(null); setDrafts([]); setError(''); setNotice(''); }}>取消编辑</button></div>
    </form>}
    {snapshot && <><button type="button" disabled={busy || addingSource} onClick={() => { setAddingSource(true); setSourceNotice(''); }}>补录缺失人工来源</button>{addingSource && <ManualEvidenceSource projectId={projectId} initialVersion={snapshot.version} onSaved={() => { setAddingSource(false); setSourceNotice('人工来源已保存，仍待核验。请在引用中选择来源并核对后保存。'); void load(true); }} onCancel={() => setAddingSource(false)} />}</>}
    {sourceNotice && <p role="status">{sourceNotice}</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
