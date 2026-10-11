import type { ReactNode } from 'react';
import { ProjectWorkspaceNav, type ProjectWorkspaceSection } from './ProjectWorkspaceNav';
import { ProjectWorkspaceTopbar } from './ProjectWorkspaceTopbar';

export function ProjectWorkspaceFrame({ projectId, projectName, active, title, children }: { projectId: string; projectName: string; active: ProjectWorkspaceSection; title: string; children: ReactNode }) {
  return <div className="project-hub-shell"><ProjectWorkspaceNav projectId={projectId} projectName={projectName} active={active} /><ProjectWorkspaceTopbar projectId={projectId} projectName={projectName} title={title} /><main className="project-hub-content">{children}</main></div>;
}
