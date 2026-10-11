import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';

export function ProjectWorkspaceTopbar({ projectId, projectName, title }: { projectId: string; projectName: string; title: string }) {
  return <header className="workspace-topbar"><div className="workspace-breadcrumb"><Link to={`/project/${encodeURIComponent(projectId)}`}>{projectName || '当前项目'}</Link><ChevronRight size={14} aria-hidden="true" /><h1>{title}</h1></div><Link className="workspace-topbar-action" to={`/editor/${encodeURIComponent(projectId)}`}>打开文稿</Link></header>;
}
