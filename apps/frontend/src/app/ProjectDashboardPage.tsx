import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  cancelProjectTask,
  checkProjectPaperSource,
  getProjectDashboard,
  getWritingQuality,
  importProjectPaper,
  previewProjectPaperImport,
  confirmProjectPaperImport,
  initializeProject,
  listProjectPapers,
  listProjectTasks,
  retryProjectTask,
  updateProjectPaper,
  type PaperImportPreview,
  type PaperImportPreviewItem,
  type PaperLibraryRecord,
  type ProjectDashboard,
  type ProjectTask
} from '../api/projectAdapter';
import { PaperSourceReview, SourceReviewHistory } from './project/PaperSourceReview';
import './ProjectDashboard.css';
import { ProjectWorkspaceNav, type ProjectWorkspaceSection } from './components/ProjectWorkspaceNav';
import { ApprovalsInbox, ConstraintsPanel, EvidenceView, HarnessConsole } from './project/ProjectControlViews';

type View = 'overview' | 'library' | 'tasks' | 'quality' | 'approvals' | 'runs' | 'evidence' | 'settings';

function viewFromPath(pathname: string): View {
  if (pathname.endsWith('/library')) return 'library';
  if (pathname.endsWith('/tasks')) return 'tasks';
  if (pathname.endsWith('/quality')) return 'quality';
  if (pathname.endsWith('/approvals')) return 'approvals';
  if (pathname.endsWith('/runs')) return 'runs';
  if (pathname.endsWith('/evidence')) return 'evidence';
  if (pathname.endsWith('/settings')) return 'settings';
  return 'overview';
}

function relativeTime(value?: string) {
  if (!value) return '尚未记录';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function statusLabel(status: string) {
  return ({ queued: '排队中', running: '运行中', paused: '已暂停', awaiting_approval: '待批准', approved: '已批准', completed: '已完成', failed: '失败', cancelled: '已取消', rejected: '已拒绝', unread: '未读', reading: '阅读中', read: '已读', archived: '已归档' } as Record<string, string>)[status] || status;
}

const IMPORT_FIELDS = ['title', 'authors', 'year', 'doi', 'arxivId', 'url', 'venue', 'abstract', 'bibtex', 'citationKey'] as const;
const IMPORT_FIELD_LABELS: Record<string, string> = { title: '标题', authors: '作者', year: '年份', doi: 'DOI', arxivId: 'arXiv', url: '链接', venue: '期刊/会议', abstract: '摘要', bibtex: 'BibTeX', citationKey: '引用键' };

function Layout({ projectId, projectName, view, children }: { projectId: string; projectName: string; view: View; children: React.ReactNode }) {
  const active: ProjectWorkspaceSection = view === 'overview' ? 'overview'
    : view === 'library' || view === 'evidence' ? 'library'
      : view === 'quality' ? 'writing'
        : view === 'settings' ? 'settings'
          : 'activity';
  const secondary = view === 'library' || view === 'evidence'
    ? [
        { label: '论文', href: `/project/${projectId}/library`, active: view === 'library' },
        { label: 'Evidence', href: `/project/${projectId}/evidence`, active: view === 'evidence' }
      ]
    : ['tasks', 'approvals', 'runs'].includes(view)
      ? [
          { label: '任务', href: `/project/${projectId}/tasks`, active: view === 'tasks' },
          { label: '审批', href: `/project/${projectId}/approvals`, active: view === 'approvals' },
          { label: 'Harness', href: `/project/${projectId}/runs`, active: view === 'runs' }
        ]
      : view === 'quality'
        ? [
            { label: '论文编辑', href: `/editor/${projectId}`, active: false },
            { label: '质量检查', href: `/project/${projectId}/quality`, active: true }
          ]
        : [];
  return <div className="project-hub-shell">
    <ProjectWorkspaceNav projectId={projectId} projectName={projectName} active={active} />
    {secondary.length > 0 && <nav className="project-hub-subnav" aria-label="当前分组视图">
      {secondary.map((item) => <Link key={item.href} className={item.active ? 'is-active' : ''} to={item.href}>{item.label}</Link>)}
    </nav>}
    <main className="project-hub-content">{children}</main>
  </div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="project-hub-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

function SetupCard({ projectId, onDone }: { projectId: string; onDone: () => Promise<void> }) {
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState('');
  const [keywords, setKeywords] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [contextBudget, setContextBudget] = useState('12000');
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [allowExperiment, setAllowExperiment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!question.trim()) { setError('请先填写研究问题。'); return; }
    setBusy(true); setError('');
    try {
      await initializeProject(projectId, {
        researchQuestion: question,
        scope,
        keywords: keywords.split(',').map((item) => item.trim()).filter(Boolean),
        model,
        constraints: {
          contextTokenBudget: Number(contextBudget) || 12000,
          networkAllowlist: allowNetwork ? ['export.arxiv.org'] : [],
          capabilities: ['project.read', 'patch.propose', ...(allowExperiment ? ['experiment.execute'] : [])]
        }
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  return <section className="hub-setup-card">
    <div className="hub-section-heading"><div><span className="hub-kicker">FIRST RUN</span><h2>初始化研究项目</h2><p>先确定研究问题和 Harness 约束，再进入第一阶段。</p></div><span className="hub-step-badge">01 / 01</span></div>
    <form className="hub-form" onSubmit={submit}>
      <label className="hub-field hub-field-wide"><span>研究问题 <b>*</b></span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：如何让长上下文检索保持可验证？" rows={3} /></label>
      <label className="hub-field"><span>研究范围</span><input value={scope} onChange={(event) => setScope(event.target.value)} placeholder="数据集、领域或时间范围" /></label>
      <label className="hub-field"><span>种子关键词</span><input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="用逗号分隔" /></label>
      <label className="hub-field"><span>默认模型</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <label className="hub-field"><span>上下文 Token 预算</span><input type="number" min="1000" step="1000" value={contextBudget} onChange={(event) => setContextBudget(event.target.value)} /></label>
      <label className="hub-check"><input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} /><span>允许 Harness 检索 arXiv 元数据</span></label>
      <label className="hub-check"><input type="checkbox" checked={allowExperiment} onChange={(event) => setAllowExperiment(event.target.checked)} /><span>允许人工批准后的受控实验执行</span></label>
      {error && <p className="hub-error hub-field-wide">{error}</p>}
      <div className="hub-form-actions"><button className="hub-primary-button" disabled={busy}>{busy ? '正在保存…' : '保存并开始研究方向'}</button><span>默认只读，文件修改仍需人工确认。</span></div>
    </form>
  </section>;
}

function Overview({ dashboard, projectId }: { dashboard: ProjectDashboard; projectId: string }) {
  const workflow = dashboard.workflow;
  return <>
    <div className="hub-page-heading"><div><span className="hub-kicker">PROJECT CONTROL ROOM</span><h2>{dashboard.project.researchQuestion || '项目概览'}</h2><p>{dashboard.project.researchScope || '从问题、证据和人工决策进入同一个项目上下文。'}</p></div><Link className="hub-primary-button" to={dashboard.nextAction.href}>{dashboard.nextAction.label} →</Link></div>
    <div className="hub-stat-grid">
      <div><span>阶段进度</span><strong>{dashboard.progress.percent}%</strong><small>{dashboard.progress.completed} / {dashboard.progress.total} 已完成</small></div>
      <div><span>待审批</span><strong>{dashboard.approvals.length}</strong><small>需要人工决定</small></div>
      <div><span>论文资料</span><strong>{dashboard.library.count}</strong><small>{dashboard.library.unread} 篇未读</small></div>
      <div><span>失败任务</span><strong className={dashboard.tasks.failed ? 'is-risk' : ''}>{dashboard.tasks.failed}</strong><small>{dashboard.tasks.active} 个待处理</small></div>
    </div>
    <div className="hub-progress-track"><span style={{ width: `${dashboard.progress.percent}%` }} /></div>
    <div className="hub-dashboard-grid">
      <section className="hub-panel hub-next-panel"><div className="hub-section-heading"><div><span className="hub-kicker">NEXT ACTION</span><h3>{dashboard.nextAction.label}</h3></div><span className="hub-muted">{dashboard.nextAction.reason}</span></div><Link className="hub-text-link" to={dashboard.nextAction.href}>进入当前工作 →</Link></section>
      <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">REVIEW QUEUE</span><h3>待审批事项</h3></div><Link className="hub-text-link" to={`/project/${projectId}/approvals`}>打开收件箱</Link></div>{dashboard.approvals.length ? <div className="hub-list">{dashboard.approvals.map((approval) => <Link className="hub-list-row" key={approval.stageId} to={`/editor/${projectId}/research/${approval.stageId === 'ideation' ? 'innovation' : approval.stageId}`}><span className="hub-index">!</span><div><strong>{approval.label}</strong><small>已通过结构校验，等待人工确认</small></div><b>→</b></Link>)}</div> : <EmptyState title="没有待审批事项" detail="当前阶段会在满足条件后出现在这里。" />}</section>
      <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">RISK REGISTER</span><h3>项目风险</h3></div><Link className="hub-text-link" to={`/project/${projectId}/quality`}>检查写作</Link></div>{dashboard.risks.length ? <div className="hub-list">{dashboard.risks.map((item) => <Link className="hub-list-row" key={item.id} to={item.href || `/project/${projectId}`}><span className={`hub-risk-dot ${item.severity}`} /><div><strong>{item.title}</strong><small>{item.detail}</small></div><b>→</b></Link>)}</div> : <EmptyState title="暂无风险提示" detail="项目状态和检查结果正常。" />}</section>
      <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">RECENT RUNS</span><h3>最近 Harness 运行</h3></div><Link className="hub-text-link" to={`/project/${projectId}/runs`}>打开控制台</Link></div>{dashboard.recentRuns.length ? <div className="hub-list">{dashboard.recentRuns.slice(0, 5).map((run) => <Link className="hub-list-row" to={`/project/${projectId}/runs`} key={run.id}><span className={`hub-status-dot ${run.status}`} /><div><strong>{run.stage || '未命名阶段'} / {run.task || 'task'}</strong><small>{statusLabel(run.status)} · {relativeTime(run.updatedAt)}</small></div><code>{String(run.id).slice(0, 8)}</code></Link>)}</div> : <EmptyState title="还没有 Harness 运行" detail="从研究阶段启动一次受约束的 AI 任务。" />}</section>
      <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">PROJECT SIGNALS</span><h3>当前配置</h3></div><Link className="hub-text-link" to={`/project/${projectId}/settings`}>查看约束</Link></div><dl className="hub-detail-list"><div><dt>当前阶段</dt><dd>{dashboard.currentStage?.label || '尚未开始'}</dd></div><div><dt>模型</dt><dd>{dashboard.model || '未配置'}</dd></div><div><dt>Harness 权限</dt><dd>{dashboard.constraints.capabilities.join(', ')}</dd></div><div><dt>Evidence 主张</dt><dd><Link className="hub-small-link" to={`/project/${projectId}/evidence`}>{dashboard.quality.supportedClaims} / {dashboard.quality.totalClaims} 已支持</Link></dd></div></dl></section>
    </div>
    {!workflow && <p className="hub-muted hub-footnote">完成初始化后，研究方向会自动成为第一阶段的起点。</p>}
  </>;
}

function Library({ dashboard, projectId }: { dashboard: ProjectDashboard; projectId: string }) {
  const [papers, setPapers] = useState<PaperLibraryRecord[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [bibtexDraft, setBibtexDraft] = useState('');
  const [preview, setPreview] = useState<PaperImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importDecisions, setImportDecisions] = useState<Record<number, { action: 'create' | 'keep' | 'merge'; fields: string[] }>>({});
  const candidates = (dashboard.workflow?.papers || []) as Partial<PaperLibraryRecord>[];
  const load = useCallback(async () => { const result = await listProjectPapers(projectId, query ? { query } : {}); setPapers(result.papers || []); }, [projectId, query]);
  useEffect(() => { load().catch((err) => setStatus(String(err))); }, [load]);
  const importCandidate = async (paper: Partial<PaperLibraryRecord>) => {
    try { await importProjectPaper(projectId, { ...paper, title: paper.title || 'Untitled paper' }); setStatus('论文已加入资料库'); await load(); } catch (err) { setStatus(String(err)); }
  };
  const update = async (paper: PaperLibraryRecord, patch: Partial<PaperLibraryRecord>) => { try { await updateProjectPaper(projectId, paper.id, patch); await load(); setStatus('资料已保存'); return true; } catch (err) { setStatus(`保存失败：${String(err)}`); return false; } };
  const beginEdit = (paper: PaperLibraryRecord) => { setEditingId(paper.id); setNoteDraft(paper.notes); setAnnotationDraft(''); setTagDraft(''); };
  const saveEdit = async (paper: PaperLibraryRecord) => {
    const tags = tagDraft.trim() ? [...new Set([...paper.tags, ...tagDraft.split(',').map((item) => item.trim()).filter(Boolean)])] : paper.tags;
    const annotationTime = new Date().toISOString();
    const annotations = annotationDraft.trim() ? [...paper.annotations, { id: crypto.randomUUID(), text: annotationDraft.trim(), createdAt: annotationTime, updatedAt: annotationTime }] : paper.annotations;
    if (await update(paper, { notes: noteDraft, tags, annotations })) setEditingId(null);
  };
  const previewBibtex = async () => {
    setImportBusy(true);
    try {
      const result = await previewProjectPaperImport(projectId, bibtexDraft);
      setPreview(result.preview);
      setImportDecisions(Object.fromEntries(result.preview.items.map((item) => [item.index, { action: item.duplicates.length ? 'keep' : 'create', fields: [] }])));
      setStatus(`已预览 ${result.preview.count} 条记录。字段完整性不等于来源已核验。`);
    } catch (err) { setStatus(`预览失败：${err instanceof Error ? err.message : String(err)}`); }
    finally { setImportBusy(false); }
  };
  const confirmItem = async (item: PaperImportPreviewItem) => {
    if (!preview) return;
    const decision = importDecisions[item.index];
    if (!decision) return;
    if (preview.originalText !== bibtexDraft) {
      setPreview(null);
      setStatus('BibTeX 草稿已变化，请重新预览后再确认。');
      return;
    }
    if (decision.action === 'create' && item.duplicates.some((duplicate) => duplicate.scope === 'project')) {
      setStatus('重复条目不能创建，请选择保留或合并。');
      return;
    }
    if (decision.action === 'merge' && (!item.expectedRevision || !decision.fields.length)) {
      setStatus(item.expectedRevision ? '合并至少选择一个字段。' : '新条目不能合并，请选择创建。');
      return;
    }
    setImportBusy(true);
    try {
      await confirmProjectPaperImport(projectId, { text: preview.originalText, inputDigest: preview.inputDigest, index: item.index, expectedRevision: item.expectedRevision, ...decision });
      setStatus(decision.action === 'keep' ? (item.expectedRevision === null ? '已跳过条目，未写入资料库。' : '已保留现有资料。') : '已按人工选择写入资料库。');
      setPreview((current) => current ? { ...current, items: current.items.filter((candidate) => candidate.index !== item.index), count: current.count - 1 } : current);
      await load().catch(() => setStatus('导入决定已处理，但资料列表刷新失败；请刷新页面查看，勿重复确认。'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('IMPORT_PREVIEW_STALE')) {
        setPreview(null);
        setStatus('资料库已变化；原始 BibTeX 已保留，请重新预览并选择写入方式。');
      } else setStatus(`确认失败：${message}`);
    } finally { setImportBusy(false); }
  };
  const chooseDecision = (item: PaperImportPreviewItem, action: 'create' | 'keep' | 'merge') => setImportDecisions((current) => ({ ...current, [item.index]: { action, fields: action === 'merge' ? current[item.index]?.fields || [] : [] } }));
  const toggleMergeField = (item: PaperImportPreviewItem, field: string) => setImportDecisions((current) => {
    const decision = current[item.index] || { action: 'merge' as const, fields: [] };
    const fields = decision.fields.includes(field) ? decision.fields.filter((candidate) => candidate !== field) : [...decision.fields, field];
    return { ...current, [item.index]: { action: 'merge', fields } };
  });
  return <>
    <div className="hub-page-heading"><div><span className="hub-kicker">PAPER LIBRARY</span><h2>论文资料库</h2><p>把检索候选、来源、阅读判断、笔记和 Evidence 放在同一份项目记录里。</p></div><div className="hub-heading-stat"><strong>{dashboard.library.count}</strong><span>篇已导入</span></div></div>
    <section className="hub-panel hub-library-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、作者、摘要或笔记" /><span role="status">{status || `${dashboard.library.unread} 篇未读 · ${dashboard.library.favorites} 篇收藏`}</span></section>
    <PaperSourceReview key={projectId} projectId={projectId} papers={papers} onSaved={load} />
    <section className="hub-panel hub-import-panel"><div className="hub-section-heading"><div><span className="hub-kicker">HUMAN IMPORT REVIEW</span><h3>导入 BibTeX</h3></div><span className="hub-muted">先预览，再逐条决定写入方式</span></div><textarea value={bibtexDraft} disabled={importBusy} onChange={(event) => { setBibtexDraft(event.target.value); setPreview(null); }} rows={5} placeholder="粘贴 BibTeX 条目" aria-label="BibTeX 输入" /><p className="hub-muted">最多 100 KiB、200 条。保留已有资料或跳过条目不会写入；合并仅覆盖勾选字段。</p><div className="hub-import-actions"><button className="hub-small-button" onClick={() => void previewBibtex()} disabled={importBusy || !bibtexDraft.trim()}>预览条目</button>{preview && <button className="hub-small-button is-quiet" onClick={() => setPreview(null)} disabled={importBusy}>清除预览</button>}</div>{preview && <div className="hub-import-review" aria-live="polite">{preview.items.length === 0 ? <p className="hub-muted">所有预览条目均已处理。</p> : preview.items.map((item) => { const decision = importDecisions[item.index] || { action: 'create' as const, fields: [] }; return <article className="hub-import-item" key={item.index}><div><strong>{item.candidate.title || '无标题'}</strong><small>{(item.candidate.authors || []).join(', ') || '作者待确认'} · {item.candidate.year || '年份待确认'}</small><div className="hub-import-flags"><span className={item.checks.fields.status === 'complete' ? 'is-ok' : 'is-warning'}>{item.checks.fields.status === 'complete' ? '字段完整' : `字段待补：${item.checks.fields.issues.join('、')}`}</span><span className="is-warning">来源未核验</span>{item.duplicates.length > 0 && <span className="is-warning">检测到重复：{item.duplicates.map((duplicate) => duplicate.scope === 'project' ? '项目资料' : `批内第 ${Number(duplicate.index) + 1} 条`).join('、')}</span>}</div>{item.conflicts.length > 0 && <details className="hub-import-conflicts"><summary>查看 {item.conflicts.length} 处字段差异</summary><ul>{item.conflicts.map((conflict) => <li key={`${conflict.scope}-${conflict.field}`}><b>{IMPORT_FIELD_LABELS[conflict.field] || conflict.field} · {conflict.scope === 'project' ? '项目资料' : '批内条目'}</b><span>现有：{String(conflict.existing ?? '空') || '空'}</span><span>导入：{String(conflict.incoming ?? '空') || '空'}</span></li>)}</ul></details>}</div>{decision.action === 'merge' && <fieldset className="hub-import-fields" disabled={importBusy}><legend>选择要覆盖的字段</legend>{IMPORT_FIELDS.filter((field) => item.conflicts.some((conflict) => conflict.scope === 'project' && conflict.field === field)).map((field) => <label key={field}><input type="checkbox" checked={decision.fields.includes(field)} onChange={() => toggleMergeField(item, field)} />{IMPORT_FIELD_LABELS[field]}</label>)}{!item.conflicts.length && <span className="hub-muted">没有检测到字段差异</span>}</fieldset>}<div className="hub-import-controls"><div className="hub-segmented" role="group" aria-label={`条目 ${item.index + 1} 决策`}><button className={decision.action === 'create' ? 'is-active' : ''} onClick={() => chooseDecision(item, 'create')} aria-pressed={decision.action === 'create'} disabled={importBusy || item.expectedRevision !== null}>创建</button><button className={decision.action === 'keep' ? 'is-active' : ''} aria-pressed={decision.action === 'keep'} disabled={importBusy} onClick={() => chooseDecision(item, 'keep')}>{item.expectedRevision === null ? '跳过' : '保留'}</button><button className={decision.action === 'merge' ? 'is-active' : ''} aria-pressed={decision.action === 'merge'} onClick={() => chooseDecision(item, 'merge')} disabled={importBusy || item.expectedRevision === null || !item.conflicts.some((conflict) => conflict.scope === 'project')}>合并</button></div><button className="hub-small-button" onClick={() => void confirmItem(item)} disabled={importBusy || (decision.action === 'merge' && (!item.expectedRevision || !decision.fields.length))}>确认</button></div></article> })}</div>}</section>
    {candidates.length > 0 && <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">FROM SEARCH</span><h3>研究流程中的候选论文</h3></div><span className="hub-muted">导入后可持续阅读和标注</span></div><div className="hub-candidate-list">{candidates.slice(0, 8).map((paper) => <div className="hub-candidate" key={String(paper.id)}><div><strong>{paper.title}</strong><small>{(paper.authors || []).join(', ')} · {paper.year || '年份待确认'}</small></div><button className="hub-small-button" onClick={() => importCandidate(paper)}>导入资料库</button></div>)}</div></section>}
    <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">READING QUEUE</span><h3>我的论文</h3></div><span className="hub-muted">支持去重、笔记、批注和来源检查</span></div>{papers.length ? <div className="hub-paper-list">{papers.map((paper) => <article className="hub-paper-row" key={paper.id}><div className="hub-paper-main"><div className="hub-paper-title"><h3>{paper.title}</h3><button className={paper.favorite ? 'hub-star is-active' : 'hub-star'} onClick={() => update(paper, { favorite: !paper.favorite })} aria-label="收藏">★</button></div><p>{paper.authors.join(', ') || '作者待确认'} · {paper.venue || '来源待确认'} · {paper.year || '年份待确认'}</p><small>{paper.abstract || '暂无摘要。'}</small><div className="hub-paper-meta"><span className={`hub-source-status ${paper.sourceCheck?.status === 'checked' ? 'is-ok' : 'is-warning'}`}>{paper.sourceCheck?.status === 'checked' ? '书目字段已检查' : '书目字段待检查'}</span><span>{paper.tags.join(' · ') || '无标签'}</span><span>{paper.annotations.length} 条批注</span></div><SourceReviewHistory paper={paper} />{editingId === paper.id && <div className="hub-paper-notes"><label>项目笔记<textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} rows={3} placeholder="记录阅读判断、方法限制或与研究问题的关系" /></label><label>新增批注<input value={annotationDraft} onChange={(event) => setAnnotationDraft(event.target.value)} placeholder="摘录或页码说明" /></label><label>添加标签<input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="多个标签用逗号分隔" /></label><div><button className="hub-small-button" onClick={() => saveEdit(paper)}>保存资料</button><button className="hub-small-button is-quiet" onClick={() => setEditingId(null)}>取消</button></div></div>}</div><div className="hub-paper-actions"><select value={paper.readingStatus} onChange={(event) => update(paper, { readingStatus: event.target.value as PaperLibraryRecord['readingStatus'] })} aria-label="阅读状态">{['unread', 'reading', 'read', 'archived'].map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select><button className="hub-small-button" onClick={() => beginEdit(paper)}>笔记与批注</button><button className="hub-small-button" onClick={async () => { try { await checkProjectPaperSource(projectId, paper.id); await load(); } catch (err) { setStatus(String(err)); } }}>检查书目字段</button><a className="hub-small-link" href={paper.url || '#'} target="_blank" rel="noreferrer">打开来源 ↗</a></div></article>)}</div> : <EmptyState title="资料库还是空的" detail="先在研究流程中完成论文检索，再把候选导入这里。" />}</section>
  </>;
}

function Tasks({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => { const result = await listProjectTasks(projectId); setTasks(result.tasks || []); }, [projectId]);
  useEffect(() => { load().catch((err) => setError(String(err))); }, [load]);
  const hasActiveTasks = tasks.some((task) => ['queued', 'running', 'paused'].includes(task.status));
  const hasPendingApproval = tasks.some((task) => task.status === 'awaiting_approval');
  useEffect(() => {
    if (!hasActiveTasks && !hasPendingApproval) return undefined;
    const timer = window.setInterval(() => { void load().catch((err) => setError(String(err))); }, hasActiveTasks ? 1500 : 10000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, hasPendingApproval, load]);
  const action = async (task: ProjectTask, kind: 'retry' | 'cancel') => { try { if (kind === 'retry') await retryProjectTask(projectId, task.id); else await cancelProjectTask(projectId, task.id); await load(); } catch (err) { setError(String(err)); } };
  return <>
    <div className="hub-page-heading"><div><span className="hub-kicker">TASK CENTER</span><h2>任务中心</h2><p>Harness、论文导入、编译和受控实验统一保留状态、日志和失败入口。</p></div><div className="hub-heading-stat"><strong>{tasks.filter((task) => ['queued', 'running', 'paused', 'awaiting_approval'].includes(task.status)).length}</strong><span>个待处理任务</span></div></div>
    {error && <p className="hub-error">{error}</p>}
    <section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">ACTIVITY</span><h3>最近任务</h3></div><span className="hub-muted">失败 Run 可重试，启动前始终需要人工批准</span></div>{tasks.length ? <div className="hub-task-list">{tasks.map((task) => <article className="hub-task-row" key={task.id}><div className={`hub-task-icon ${task.status}`}>{['completed', 'approved'].includes(task.status) ? '✓' : task.status === 'failed' ? '!' : '•'}</div><div className="hub-task-copy"><div><strong>{task.title}</strong><span className={`hub-task-status ${task.status}`}>{statusLabel(task.status)}</span></div><small>{task.kind} · {task.stage || '项目'} · {relativeTime(task.updatedAt)}</small><div className="hub-task-progress"><span style={{ width: `${task.progress}%` }} /></div>{task.error?.message && <p className="hub-task-error">{task.error.message}</p>}{task.log.length > 0 && <details><summary>查看日志（{task.log.length}）</summary><pre>{task.log.slice(-20).join('\n')}</pre></details>}</div><div className="hub-task-actions">{task.status === 'awaiting_approval' && ['research-stage', 'experiment'].includes(task.kind) && <Link className="hub-small-link" to={`/project/${projectId}/approvals`}>查看审批</Link>}{task.retryable && <button className="hub-small-button" onClick={() => action(task, 'retry')}>重试</button>}{['queued', 'running', 'paused'].includes(task.status) && <button className="hub-small-button is-quiet" onClick={() => action(task, 'cancel')}>取消</button>}</div></article>)}</div> : <EmptyState title="还没有任务记录" detail="研究阶段、Harness、编译和受控实验结果会自动出现在这里。" />}</section>
  </>;
}

function Quality({ projectId }: { projectId: string }) {
  const [quality, setQuality] = useState<any>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => { const result = await getWritingQuality(projectId); setQuality(result.quality); }, [projectId]);
  useEffect(() => { load().catch((err) => setError(String(err))); }, [load]);
  if (error) return <p className="hub-error">{error}</p>;
  if (!quality) return <EmptyState title="正在读取写作检查" detail="主张、引用、术语和编译结果会在这里汇总。" />;
  return <>
    <div className="hub-page-heading"><div><span className="hub-kicker">WRITING QUALITY</span><h2>写作质量面板</h2><p>把主张-证据矩阵、引用完整性、术语一致性、编译问题和 AI 检查放在一个回查入口。</p></div><span className={`hub-quality-badge ${quality.overall}`}>{quality.overall === 'pass' ? '当前通过' : '需要处理'}</span></div>
    <div className="hub-quality-grid"><section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">CLAIMS / EVIDENCE</span><h3>主张-证据矩阵</h3></div><span className="hub-quality-count">{quality.claims.supportedClaims} / {quality.claims.totalClaims}</span></div><div className="hub-quality-summary"><span className="is-ok">已支持 {quality.claims.supportedClaims}</span><span className="is-warning">待验证 {quality.claims.needsVerificationClaims}</span><span className="is-error">无支持 {quality.claims.unsupportedClaims}</span></div>{quality.claims.rows.length ? <div className="hub-claim-list">{quality.claims.rows.map((row: any) => <div className="hub-claim" key={row.id}><strong>{row.text}</strong><span className={`hub-claim-status ${row.status}`}>{row.status === 'supported' ? '已支持' : row.status === 'needs-verification' ? '需验证' : '无支持'}</span><small>Evidence: {row.evidenceIds.join(', ') || 'none'}</small></div>)}</div> : <EmptyState title="还没有论文主张" detail="完成写作交接后，主张会关联到 Evidence。" />}</section><section className="hub-panel"><div className="hub-section-heading"><div><span className="hub-kicker">MANUSCRIPT CHECKS</span><h3>稿件检查</h3></div><span className="hub-muted">{quality.checkedAt ? relativeTime(quality.checkedAt) : ''}</span></div><div className="hub-check-list"><CheckRow label="引用完整性" ok={quality.citations.ok} detail={quality.citations.missingKeys.length ? `缺少：${quality.citations.missingKeys.join(', ')}` : `已识别 ${quality.citations.citedKeys.length} 个引用`} /><CheckRow label="术语一致性" ok={quality.terminology.ok} detail={quality.terminology.variants.length ? '发现同一术语的多种写法' : '未发现关键词变体冲突'} /><CheckRow label="编译结果" ok={quality.compile.ok} detail={quality.compile.issues.length ? `${quality.compile.issues.length} 个编译失败任务` : '没有记录中的编译失败'} /><CheckRow label="AI 检查" ok={quality.ai.status === 'available'} detail={quality.ai.status === 'available' ? `${quality.ai.checks.length} 条检查结果可回查` : '尚未记录写作 Harness 检查'} /></div></section></div>
  </>;
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return <div className="hub-check-row"><span className={ok ? 'is-ok' : 'is-warning'}>{ok ? '✓' : '!'}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

export default function ProjectDashboardPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);
  const [dashboard, setDashboard] = useState<ProjectDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { const result = await getProjectDashboard(projectId); setDashboard(result.dashboard); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setLoading(false); } }, [projectId]);
  useEffect(() => { load(); }, [load, location.pathname]);
  if (loading && !dashboard) return <Layout projectId={projectId} projectName="" view={view}><div className="project-hub-loading" role="status">正在读取项目状态…</div></Layout>;
  if (error && !dashboard) return <Layout projectId={projectId} projectName="项目" view={view}><div className="project-hub-loading hub-error" role="alert">{error}<button className="hub-small-button" onClick={() => void load()}>重试</button></div></Layout>;
  if (!dashboard) return null;
  const content = !dashboard.initialized && view === 'overview'
    ? <SetupCard projectId={projectId} onDone={load} />
    : view === 'library' ? <Library dashboard={dashboard} projectId={projectId} />
      : view === 'tasks' ? <Tasks projectId={projectId} />
        : view === 'quality' ? <Quality projectId={projectId} />
          : view === 'approvals' ? <ApprovalsInbox projectId={projectId} approvals={dashboard.approvals} />
            : view === 'runs' ? <HarnessConsole projectId={projectId} />
              : view === 'evidence' ? <EvidenceView projectId={projectId} />
                : view === 'settings' ? <ConstraintsPanel projectId={projectId} constraints={dashboard.constraints} />
          : <Overview dashboard={dashboard} projectId={projectId} />;
  return <Layout projectId={projectId} projectName={dashboard.project.name} view={view}>
    {content}
    {loading && <p role="status">正在刷新项目状态…</p>}
    {error && <div className="hub-error" role="alert"><p>刷新失败，当前仍显示上次读取的项目状态；未保存的输入已保留。</p><p>{error}</p><button className="hub-small-button" disabled={loading} onClick={() => void load()}>重试</button></div>}
    <button className="hub-refresh" disabled={loading} onClick={() => { load(); navigate(location.pathname); }} aria-label="刷新项目状态">↻</button>
  </Layout>;
}
