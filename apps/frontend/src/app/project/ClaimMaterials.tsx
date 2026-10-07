import { useState } from 'react';
import { getCollabToken, type ClaimEvidenceRow, type EvidenceRecord } from '../../api/client';
import './ClaimMaterials.css';

function safeProjectPath(value: unknown) {
  const candidate = typeof value === 'string' ? value : '';
  if (!candidate || /[\\:\u0000-\u001f\u007f]/.test(candidate) || candidate.split('/').some((part) => !part || part === '..' || part === '.')) return null;
  if (candidate.split('/').some((part) => part.startsWith('.')) && !/^\.scienceprism\/experiment-runs\/[^/.][^/]*\/artifacts\/(?:[^/.][^/]*\/)*[^/.][^/]*$/.test(candidate)) return null;
  return candidate;
}

function SourceLocation({ projectId, source, historical = false }: { projectId: string; source: EvidenceRecord['source']; historical?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const filePath = safeProjectPath(source?.path);
  const download = async () => {
    if (!filePath || busy) return;
    setBusy(true);
    setError('');
    try {
      const token = getCollabToken();
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/blob?${new URLSearchParams({ path: filePath })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error(`文件不可用（HTTP ${response.status}），请核对当前项目路径或重试。`);
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filePath.split('/').pop() || 'material';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '下载失败，请重试。');
    } finally { setBusy(false); }
  };
  let url: string | null = null;
  try {
    const parsed = new URL(source?.url || '');
    if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href;
  } catch { /* Missing or invalid locations remain plain text. */ }
  return <div className="claim-material-location">
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">打开来源（新窗口）：{url}</a> : <span>未记录可打开的 HTTP(S) 来源</span>}
    {source?.path && <>
      <span>记录路径：<code>{source.path}</code></span>
      {filePath ? <div><button type="button" disabled={busy} onClick={() => void download()}>{busy ? '正在下载…' : '下载当前项目文件'}</button>{historical && <p>下载的是该路径当前的文件，不是引用保存时的文件快照；请核对版本和内容。</p>}</div> : <span>此路径不支持从项目下载，请核对原始材料位置。</span>}
      {error && <p role="alert">{error}</p>}
    </>}
    {source?.locator && <span>来源定位：{source.locator}</span>}
    {source?.provider && <span>提供方：{source.provider}</span>}
  </div>;
}

export function ClaimMaterials({ projectId, claim }: { projectId: string; claim: ClaimEvidenceRow }) {
  const citations = claim.citations || [];
  return <details className="claim-materials">
    <summary aria-label={`阅读引用材料：${claim.text}`}>阅读引用材料 · {claim.evidenceIds.length} 项来源</summary>
    <p>引用完整性不代表科学结论成立；请对照原始材料判断主张。摘要、人工转录与全文不同。</p>
    {!!claim.contradictingEvidenceIds?.length && <p className="claim-material-warning">存在显式反例：{claim.contradictingEvidenceIds.join('、')}。请人工对照相反材料修订或解释主张；来源已确认也不代表反例已解决。</p>}
    {!citations.length && <p>未记录人工引用片段或位置，以下仅展示当前 Evidence 材料。</p>}
    {citations.map((citation, index) => <section className="claim-material-card" key={`${citation.evidenceId}-${index}`}>
      <strong>已保存引用 · {citation.evidenceId}</strong>
      {claim.staleEvidenceIds.includes(citation.evidenceId) && <p className="claim-material-warning">材料已变化：旧引用待重新核对，来源再次确认不会自动更新此记录。</p>}
      {citation.excerpt ? <blockquote>{citation.excerpt}</blockquote> : <p>未记录引用片段</p>}
      <p>{citation.section ? `章节：${citation.section}` : '未记录章节'} · {citation.page ? `页码：${citation.page}` : '未记录页码'}{citation.locator ? ` · 定位：${citation.locator}` : ''}</p>
      <p>记录来源版本：{citation.sourceVersion} · 人工记录：{citation.recordedAt}</p>
      <SourceLocation key={`${projectId}:${citation.sourceSnapshot?.path || ''}`} projectId={projectId} source={citation.sourceSnapshot} historical />
    </section>)}
    {(claim.evidence || []).map((entry) => <section className="claim-material-card" key={entry.id}>
      <strong>{claim.contradictingEvidenceIds?.includes(entry.id) ? '反例材料' : '当前材料'} · {entry.title || entry.id}</strong>
      <p>{entry.summary || '未记录材料摘要'}</p>
      <p>Evidence：{entry.id} · 版本：{entry.version || entry.sha256 || '未记录外部版本'}</p>
      <p>{claim.staleEvidenceIds.includes(entry.id) ? '材料已变化 · 请复核引用' : claim.unverifiedEvidenceIds.includes(entry.id) ? '来源待核验' : '来源已确认（不等于主张已获科学验证）'}</p>
      <SourceLocation key={`${projectId}:${entry.source?.path || ''}`} projectId={projectId} source={entry.source} />
    </section>)}
    {claim.missingEvidenceIds.map((id) => <p className="claim-material-warning" key={id}>来源缺失：{id}。保留的引用记录不代表当前来源可用。</p>)}
    {!claim.evidenceIds.length && <p>尚未关联来源。</p>}
  </details>;
}
