import { ArrowLeft, ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isResearchStageId } from '../research/researchStages';
import { rememberResearchStage } from '../research/researchLocation';
import { WORKSPACE_GROUPS, workspaceHref, type ProjectWorkspaceSection } from './workspaceNavigation';

export type { ProjectWorkspaceSection } from './workspaceNavigation';

function readCollapsed(projectId: string) {
  try { return localStorage.getItem(`sp_nav_collapsed:${projectId}`) === 'true'; }
  catch { return false; }
}

export function ProjectWorkspaceNav({ projectId, projectName, active }: {
  projectId: string; projectName: string; active: ProjectWorkspaceSection;
}) {
  const { t } = useTranslation();
  const { stage } = useParams();
  const selected = active === 'research' ? 'overview' : active;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(projectId));
  useEffect(() => setCollapsed(readCollapsed(projectId)), [projectId]);
  useEffect(() => {
    if (isResearchStageId(stage)) rememberResearchStage(projectId, stage);
  }, [projectId, stage]);
  const toggle = () => {
    setCollapsed(value => {
      try { localStorage.setItem(`sp_nav_collapsed:${projectId}`, String(!value)); } catch { /* Navigation remains usable without storage. */ }
      return !value;
    });
  };
  return <aside className="project-workspace-nav" data-collapsed={collapsed}>
    <div className="workspace-brand-row">
      <Link className="workspace-home" to="/" aria-label="SciencePrism 首页"><span className="workspace-brand-mark">S</span><span className="workspace-nav-copy">SciencePrism</span></Link>
      <button type="button" className="workspace-nav-toggle" onClick={toggle} aria-expanded={!collapsed} aria-controls="workspace-navigation" aria-label={t(collapsed ? '展开项目导航' : '收起项目导航')}><PanelLeft size={17} /></button>
    </div>
    <Link to="/projects" className="workspace-project-switch" title={projectName || t('正在加载…')} aria-label={t('返回项目列表')}>
      <span className="workspace-project-avatar">{projectName?.slice(0, 1) || 'P'}</span>
      <span className="workspace-nav-copy"><small>{t('当前项目')}</small><strong>{projectName || t('正在加载…')}</strong></span>
      <ChevronRight size={14} className="workspace-nav-copy" />
    </Link>
    <nav id="workspace-navigation" className="project-hub-tabs" aria-label="项目视图">
      {WORKSPACE_GROUPS.map(group => <section className="workspace-nav-group" key={group.label}>
        <h2 className="workspace-nav-copy">{t(group.label)}</h2>
        {group.items.map(item => {
          const Icon = item.icon;
          return <Link key={item.id} title={t(item.label)} aria-label={t(item.label)} aria-current={selected === item.id ? 'page' : undefined} className={selected === item.id ? 'is-active' : ''} to={workspaceHref(projectId, item.path, stage)}><Icon size={17} aria-hidden="true" /><span className="workspace-nav-copy">{t(item.label)}</span></Link>;
        })}
      </section>)}
    </nav>
    <footer className="workspace-nav-footer"><Link to="/projects" title={t('全部项目')}><ArrowLeft size={16} /><span className="workspace-nav-copy">{t('全部项目')}</span></Link><button type="button" onClick={toggle} aria-label={t(collapsed ? '展开项目导航' : '收起项目导航')}>{collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button></footer>
  </aside>;
}
