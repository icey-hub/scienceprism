import { Activity, BookOpenText, ChevronLeft, FileText, FolderSearch, LayoutDashboard, Settings2 } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isResearchStageId } from '../research/researchStages';

const lastResearchStage = new Map<string, string>();

export type ProjectWorkspaceSection = 'overview' | 'research' | 'library' | 'writing' | 'activity' | 'settings';

const ITEMS = [
  { id: 'research', label: '研究', icon: FolderSearch, path: 'research' },
  { id: 'library', label: '资料', icon: BookOpenText, path: 'library' },
  { id: 'writing', label: '文稿', icon: FileText, path: 'writing' },
  { id: 'overview', label: '项目概览', icon: LayoutDashboard, path: '' },
  { id: 'activity', label: '任务与审批', icon: Activity, path: 'tasks' },
  { id: 'settings', label: '设置', icon: Settings2, path: 'settings' }
] as const;

function itemHref(projectId: string, path: (typeof ITEMS)[number]['path']) {
  if (!path) return `/project/${projectId}`;
  if (path === 'research') return `/editor/${projectId}/research/${lastResearchStage.get(projectId) || 'direction'}`;
  if (path === 'writing') return `/editor/${projectId}`;
  return `/project/${projectId}/${path}`;
}

export function ProjectWorkspaceNav({
  projectId,
  projectName,
  active
}: {
  projectId: string;
  projectName: string;
  active: ProjectWorkspaceSection;
}) {
  const { t } = useTranslation();
  const { stage } = useParams();
  useEffect(() => {
    if (isResearchStageId(stage)) lastResearchStage.set(projectId, stage);
  }, [projectId, stage]);
  return (
    <aside className="project-workspace-nav">
      <Link className="workspace-home" to="/">SciencePrism</Link>
      <header className="project-hub-topbar">
        <div className="project-hub-brand">
          <Link to="/projects" className="project-hub-back" aria-label="返回项目列表"><ChevronLeft size={19} /></Link>
          <div><span>{t('当前项目')}</span><h1>{projectName || t('正在加载…')}</h1></div>
        </div>
      </header>
      <nav className="project-hub-tabs" aria-label="项目视图">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return <Link key={item.id} aria-current={active === item.id ? 'page' : undefined} className={`${active === item.id ? 'is-active' : ''} ${item.id === 'overview' ? 'workspace-secondary-start' : ''}`} to={itemHref(projectId, item.path)}><Icon size={18} />{t(item.label)}</Link>;
        })}
      </nav>
    </aside>
  );
}
