import { Activity, BookOpenText, ChevronLeft, FileText, FolderSearch, LayoutDashboard, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';

export type ProjectWorkspaceSection = 'overview' | 'research' | 'library' | 'writing' | 'activity' | 'settings';

const ITEMS = [
  { id: 'overview', label: '概览', icon: LayoutDashboard, path: '' },
  { id: 'research', label: '研究', icon: FolderSearch, path: 'research' },
  { id: 'library', label: '资料库', icon: BookOpenText, path: 'library' },
  { id: 'writing', label: '写作', icon: FileText, path: 'writing' },
  { id: 'activity', label: '活动', icon: Activity, path: 'tasks' },
  { id: 'settings', label: '设置', icon: Settings2, path: 'settings' }
] as const;

function itemHref(projectId: string, path: (typeof ITEMS)[number]['path']) {
  if (!path) return `/project/${projectId}`;
  if (path === 'research') return `/editor/${projectId}/research/direction`;
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
  return (
    <div className="project-workspace-nav">
      <header className="project-hub-topbar">
        <div className="project-hub-brand">
          <Link to="/projects" className="project-hub-back" aria-label="返回项目列表"><ChevronLeft size={19} /></Link>
          <div><span>SCIENCEPRISM</span><h1>{projectName || '项目'}</h1></div>
        </div>
      </header>
      <nav className="project-hub-tabs" aria-label="项目视图">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return <Link key={item.id} className={active === item.id ? 'is-active' : ''} to={itemHref(projectId, item.path)}><Icon size={16} />{item.label}</Link>;
        })}
      </nav>
    </div>
  );
}
