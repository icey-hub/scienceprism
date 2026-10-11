import { Activity, BookOpenText, FolderOpen, LayoutDashboard, ListChecks, MessageSquare, Network, Radio, Settings2, Wrench, Sparkles } from 'lucide-react';
import { researchHref } from '../research/researchLocation';

export const WORKSPACE_GROUPS = [
  { label: '功能', items: [
    { id: 'overview', label: '仪表盘', icon: LayoutDashboard, path: '' },
    { id: 'chat', label: '对话', icon: MessageSquare, path: 'chat' },
    { id: 'activity', label: '任务与会话', icon: Activity, path: 'tasks' },
    { id: 'library', label: '资料库', icon: BookOpenText, path: 'library' },
    { id: 'evidence', label: '探索', icon: Network, path: 'explore' },
    { id: 'tools', label: '工具执行', icon: Wrench, path: 'tools' },
    { id: 'runs', label: '运行记录', icon: Radio, path: 'runs' },
    { id: 'writing', label: '工作空间', icon: FolderOpen, path: 'writing' }
  ] },
  { label: '系统', items: [
    { id: 'skills', label: 'Skills', icon: Sparkles, path: 'skills' },
    { id: 'approvals', label: '审批记录', icon: ListChecks, path: 'approvals' },
    { id: 'settings', label: '项目设置', icon: Settings2, path: 'settings' }
  ] }
] as const;

export type ProjectWorkspaceSection = (typeof WORKSPACE_GROUPS)[number]['items'][number]['id'] | 'research';

export function workspaceHref(projectId: string, path: string, stage?: string) {
  const id = encodeURIComponent(projectId);
  if (path === 'research') return researchHref(projectId, stage);
  if (path === 'writing') return `/editor/${id}`;
  if (path === 'chat') return `/editor/${id}?tool=agent`;
  return `/project/${id}${path ? `/${path}` : ''}`;
}
