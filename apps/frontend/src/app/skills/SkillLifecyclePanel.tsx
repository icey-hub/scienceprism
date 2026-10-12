import { useEffect, useRef, useState } from 'react';
import {
  discoverSkills, getSkillVersions, getSkillVersionDocument, previewSkillUpdate, updateSkill, rollbackSkill, uninstallSkill,
  selectedSkillSource, type SkillInstallation, type SkillVersion, type SkillUpdatePreview, type SkillVersionDocument,
  type SelectedSkillSource, type SkillCandidate
} from '../../api/skillDiscoveryAdapter';
import { readerError } from '../../api/paperReaderAdapter';
import './SkillLifecyclePanel.css';

type Confirmation = { kind: 'rollback' | 'uninstall'; expectedVersionId: string; target?: SkillVersion };
type Props = { projectId: string; name: string; installation?: SkillInstallation; boundStages: string[]; onChanged: () => Promise<void> };

export function SkillLifecyclePanel({ projectId, name, installation, boundStages, onChanged }: Props) {
  const [versions, setVersions] = useState<SkillVersion[] | null>(null);
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState<SkillUpdatePreview | null>(null);
  const [candidate, setCandidate] = useState<SkillCandidate | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [viewVersion, setViewVersion] = useState(''); const [file, setFile] = useState('SKILL.md');
  const [document, setDocument] = useState<SkillVersionDocument | null>(null);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [note, setNote] = useState('');
  const active = useRef<AbortController | null>(null);
  const current = versions === null ? installation : versions.find(item => item.current);
  const writable = !!current?.source && !!current.versionId && current.integrity === 'verified' && current.state === 'installed';
  const writing = ['更新', '回滚', '卸载'].includes(busy);
  const perform = async (label: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(label); setError('');
    try { await work(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(readerError(cause)); }
    finally { if (active.current === controller) { active.current = null; setBusy(''); } }
  };
  const loadVersions = async (signal: AbortSignal) => {
    const result = await getSkillVersions(projectId, name, signal);
    if (signal.aborted) return;
    setVersions(result.versions);
    setViewVersion(value => result.versions.some(item => item.versionId === value) ? value : result.versions.find(item => item.versionId)?.versionId || '');
  };
  useEffect(() => {
    void perform('读取版本', loadVersions);
    return () => { active.current?.abort(); active.current = null; };
  }, [projectId, name]);
  const refresh = () => {
    setPreview(null); setCandidate(null); setConfirmation(null); setDocument(null);
    void perform('读取版本', async signal => { await loadVersions(signal); if (!signal.aborted) await onChanged(); });
  };
  const afterChange = async (signal: AbortSignal, message: string) => {
    if (signal.aborted) return;
    setPreview(null); setCandidate(null); setConfirmation(null); setNote(message);
    await loadVersions(signal); if (!signal.aborted) await onChanged();
  };
  const prepareUpdate = () => {
    if (!writable || !current?.source || !current.versionId || !ref.trim()) return;
    const source = current.source; const expected = current.versionId;
    setPreview(null); setCandidate(null); setConfirmation(null); setNote('');
    void perform('预览更新', async signal => {
      const found = await discoverSkills(projectId, { repositories: [{ repository: source.repository, path: source.path, ref: ref.trim() }], query: '', stage: null, offset: 0, filters: { installed: 'any', license: 'any' } }, signal);
      const selected = found.candidates.find(item => item.name === name && item.source.repository === source.repository && item.source.path === source.path);
      if (!selected) throw new Error(found.errors.map(item => item.message).join('；') || '指定提交中没有找到此目录下的同名 Skill；当前版本未改变。');
      const result = await previewSkillUpdate(projectId, name, selectedSkillSource(selected), expected, signal);
      if (!signal.aborted) { setCandidate(selected); setPreview(result); }
    });
  };
  const applyUpdate = () => {
    if (!preview?.current.versionId || preview.unchanged) return;
    void perform('更新', async signal => {
      await updateSkill(projectId, name, preview.selected.source, preview.current.versionId!, signal);
      await afterChange(signal, '版本已更新。下次 Run 使用新版本，旧 Run 的来源仍可查看。');
    });
  };
  const applyConfirmation = () => {
    if (!confirmation) return;
    const action = confirmation;
    void perform(action.kind === 'uninstall' ? '卸载' : '回滚', async signal => {
      if (action.kind === 'uninstall') await uninstallSkill(projectId, name, action.expectedVersionId, signal);
      else if (action.target?.versionId) await rollbackSkill(projectId, name, action.target.versionId, action.expectedVersionId, signal);
      else return;
      await afterChange(signal, action.kind === 'uninstall' ? '已卸载当前 Skill，历史来源已保留。阶段绑定未更改，可在下方移除不可用项。' : '已回滚到所选版本。阶段绑定未更改。');
    });
  };
  const readDocument = (versionId = viewVersion, path = file) => {
    if (!versionId) return;
    setDocument(null);
    void perform('读取文档', async signal => {
      const result = await getSkillVersionDocument(projectId, name, versionId, path, signal);
      if (!signal.aborted) setDocument(result);
    });
  };
  return <section className="skill-lifecycle" aria-label={`${name} 版本管理`} aria-busy={!!busy}>
    <header className="skill-lifecycle-heading"><div><h3>版本管理</h3><p>预览改动后再更新，历史来源随版本保留。</p></div><button disabled={!!busy} onClick={refresh}>刷新状态</button></header>
    {current?.source && <SourceLine source={current.source} versionId={current.versionId} />}
    {versions !== null && !current && <p className="skill-lifecycle-notice">当前未安装此 Skill。{versions.length ? '下方保留历史来源；重新使用时请在发现区明确选择安装。' : '没有托管版本记录。'}</p>}
    {current && !writable && <p className="skill-lifecycle-notice">{current.integrity === 'changed' ? '检测到本地修改，更新、回滚和卸载已暂停。请先核对修改，再刷新状态。' : '此项的固定来源或完整性无法核验，版本操作已暂停。'}{current.issues.length > 0 && <span> {current.issues.join('；')}</span>}</p>}
    <p className="skill-lifecycle-muted">当前阶段选择：{boundStages.length ? boundStages.join('、') : '未选择绑定'}。版本操作保留页面中尚未保存的绑定。</p>
    {current && <form className="skill-update-form" onSubmit={event => { event.preventDefault(); prepareUpdate(); }}>
      <label>目标分支或提交<input value={ref} onChange={event => { setRef(event.target.value); setPreview(null); setCandidate(null); }} placeholder="例如 main 或完整 commit SHA" maxLength={200} required disabled={!!busy || !writable} /></label>
      <button disabled={!!busy || !writable || !ref.trim()}>预览更新</button>
    </form>}
    {preview && <UpdatePreview preview={preview} candidate={candidate} disabled={!!busy || !writable} onUpdate={applyUpdate} />}
    {busy && <div className="skill-lifecycle-progress" role="status"><span>{busy}中…{writing ? '完成后会重新核对目录。' : ''}</span>{!writing && <button onClick={() => active.current?.abort()}>取消读取</button>}</div>}
    {error && <p className="skill-lifecycle-error" role="alert">{error} 可以刷新状态后重试。</p>}
    {note && <p className="skill-lifecycle-notice" role="status">{note}</p>}
    {versions && versions.length > 0 && <>
      <h4>保存的来源版本</h4><p className="skill-lifecycle-muted">保存记录不代表该版本已被模型使用；实际读取以 Run 记录为准。</p>
      <div className="skill-version-list"><table><thead><tr><th scope="col">来源提交</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>{versions.map((item, index) => <tr key={item.versionId || index}>
        <td><code title={item.source?.commit}>{item.source?.commit.slice(0, 12) || '来源未知'}</code>{item.versionId && <small title={item.versionId}>版本 {item.versionId.slice(0, 12)}</small>}</td>
        <td>{item.current ? '当前版本' : '历史来源'}<small>{item.integrity === 'verified' ? '摘要已核验' : '存在完整性问题'}</small></td>
        <td><div className="skill-version-actions"><button disabled={!!busy || !item.versionId} onClick={() => { setViewVersion(item.versionId!); setFile('SKILL.md'); readDocument(item.versionId, 'SKILL.md'); }}>查看原文</button>
          {!item.current && <button disabled={!!busy || !writable || item.integrity !== 'verified' || !item.versionId} onClick={() => { setPreview(null); setConfirmation({ kind: 'rollback', expectedVersionId: current!.versionId!, target: item }); }}>回滚至此版本</button>}</div></td>
      </tr>)}</tbody></table></div>
      <form className="skill-document-form" onSubmit={event => { event.preventDefault(); readDocument(); }}>
        <label>文档版本<select value={viewVersion} disabled={!!busy} onChange={event => { setViewVersion(event.target.value); setDocument(null); }}>{versions.filter(item => item.versionId).map(item => <option key={item.versionId} value={item.versionId}>{item.source?.commit.slice(0, 12)} · {item.versionId!.slice(0, 8)}{item.current ? ' · 当前' : ''}</option>)}</select></label>
        <label>Markdown 路径<input value={file} onChange={event => setFile(event.target.value)} placeholder="SKILL.md 或 references/example.md" maxLength={1024} required disabled={!!busy} /></label><button disabled={!!busy || !viewVersion || !file.trim()}>读取文档</button>
      </form>
      {document && <div className="skill-version-document"><h4>{document.file}</h4><SourceLine source={document.source} versionId={document.versionId} /><p className="skill-lifecycle-muted">{document.bytes.toLocaleString()} bytes · SHA256 <code>{document.sha256}</code></p><pre tabIndex={0} aria-label="版本原始 Markdown 文档">{document.content}</pre></div>}
    </>}
    {current && <div className="skill-uninstall-action"><span>卸载保留旧 Run 的来源文档，阶段绑定需要另行调整。</span><button disabled={!!busy || !writable} onClick={() => { setPreview(null); setConfirmation({ kind: 'uninstall', expectedVersionId: current.versionId! }); }}>卸载此 Skill</button></div>}
    {confirmation && <div className="skill-lifecycle-confirm" role="group" aria-label="确认版本操作"><h4>{confirmation.kind === 'uninstall' ? `确认卸载 ${name}` : '确认回滚到此来源版本'}</h4>
      {confirmation.target?.source && <SourceLine source={confirmation.target.source} versionId={confirmation.target.versionId} />}
      <p>{confirmation.kind === 'uninstall' ? `当前安装将移除，已保存的历史文档继续保留。${boundStages.length ? '此项仍在阶段选择中，卸载后请检查下方的不可用绑定。' : ''}` : '当前版本会保存在历史来源中，下次 Run 使用所选版本。'}</p>
      <div><button disabled={!!busy} onClick={applyConfirmation}>{confirmation.kind === 'uninstall' ? '确认卸载' : '确认回滚'}</button><button disabled={!!busy} onClick={() => setConfirmation(null)}>取消</button></div>
    </div>}
    <p className="skill-lifecycle-muted">运行时只读取所选 Markdown；附带脚本不会因安装、更新或绑定而自动执行。</p>
  </section>;
}

function SourceLine({ source, versionId }: { source: SelectedSkillSource; versionId?: string }) {
  const url = `https://github.com/${source.repository}/tree/${source.commit}/${source.path.split('/').map(encodeURIComponent).join('/')}`;
  return <div className="skill-version-source"><a href={url} target="_blank" rel="noreferrer">{source.repository} / {source.path || '(根目录)'}</a><code title={source.commit}>{source.commit.slice(0, 12)}</code>{versionId && <small title={versionId}>版本 {versionId.slice(0, 12)}</small>}</div>;
}

function UpdatePreview({ preview, candidate, disabled, onUpdate }: { preview: SkillUpdatePreview; candidate: SkillCandidate | null; disabled: boolean; onUpdate: () => void }) {
  const labels = { added: '新增', removed: '删除', changed: '修改' };
  return <section className="skill-update-preview" aria-label="更新改动预览"><h4>{preview.unchanged ? '已是所选固定版本' : '待更新版本'}</h4><SourceLine source={preview.selected.source} versionId={preview.selected.versionId} />
    {candidate && <p className="skill-lifecycle-muted">许可：{candidate.license.declaration || (candidate.license.status === 'document-found' ? '已找到文档，适用范围待核对' : '未知')} · 附带脚本 {candidate.scripts.total} 个。运行要求仍需核对。</p>}
    {!preview.changes.length && <p>{preview.unchanged ? '来源和文件摘要都与当前版本一致。' : '文件内容相同，来源提交发生了变化。'}</p>}
    {preview.changes.map(change => <details key={change.path} className="skill-file-diff"><summary>{labels[change.change]} · {change.path}</summary><div className="skill-diff-hashes"><span>之前：<code>{change.beforeDigest || '无'}</code></span><span>之后：<code>{change.afterDigest || '无'}</code></span></div>
      {change.diff ? <pre tabIndex={0} aria-label={`${change.path} 文件差异`}>{change.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'is-added' : line.startsWith('-') ? 'is-removed' : ''}>{line}{'\n'}</span>)}</pre> : <p>此文件差异未展开。</p>}
      {change.diffTruncated && <p className="skill-lifecycle-muted">预览达到长度上限，已截断；上方摘要对应完整文件。</p>}
    </details>)}
    <button className="skill-lifecycle-primary" disabled={disabled || preview.unchanged} onClick={onUpdate}>确认更新此固定版本</button>
  </section>;
}
