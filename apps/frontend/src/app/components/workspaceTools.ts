import { BarChart3, Bot, CheckCircle2, FolderTree, Globe2, Image, Search, Users } from 'lucide-react';

export const WORKSPACE_TOOLS = [
  { id: 'files', label: '项目文件', detail: '浏览项目文件，选择文稿进入写作。', icon: FolderTree },
  { id: 'agent', label: '对话', detail: '围绕项目进行问答，选择文件和 Skill，审阅修改建议。', icon: Bot },
  { id: 'search', label: '论文搜索', detail: '独立搜索论文，阅读摘要并加入文献库。', icon: Search },
  { id: 'websearch', label: '网页检索', detail: '检索网页、阅读结果并保存研究笔记。', icon: Globe2 },
  { id: 'vision', label: '图像识别', detail: '读取图片或公式，确认后插入文稿。', icon: Image },
  { id: 'plot', label: '绘图', detail: '生成科研图形，批准后执行并查看产物。', icon: BarChart3 },
  { id: 'review', label: '论文评审', detail: '评审项目文稿，在独立结果页查看审稿意见。', icon: CheckCircle2 },
  { id: 'collab', label: '协作', detail: '生成项目邀请，查看协作连接并进入共享写作。', icon: Users }
] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number]['id'];
export function isWorkspaceTool(value: string | null): value is WorkspaceTool {
  return WORKSPACE_TOOLS.some(tool => tool.id === value);
}
export function workspaceToolHref(projectId: string, tool: WorkspaceTool) {
  const id = encodeURIComponent(projectId);
  if (tool === 'agent') return `/project/${id}/chat`;
  if (tool === 'search') return `/project/${id}/papers/search`;
  return `/project/${id}/tools/${tool}`;
}
