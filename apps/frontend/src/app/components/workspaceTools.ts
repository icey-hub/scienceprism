import { BarChart3, Bot, CheckCircle2, FolderTree, Globe2, Image, Search, Users } from 'lucide-react';

export const WORKSPACE_TOOLS = [
  { id: 'files', label: '项目文件', detail: '浏览和编辑项目文件，编译文稿与查看 PDF。', icon: FolderTree },
  { id: 'agent', label: '对话', detail: '使用选区、文件和 Skill，审阅助手提出的修改。', icon: Bot },
  { id: 'search', label: '论文检索', detail: '检索文献、选择来源并插入引用。', icon: Search },
  { id: 'websearch', label: '网页检索', detail: '检索网页、阅读结果并保存研究笔记。', icon: Globe2 },
  { id: 'vision', label: '图像识别', detail: '读取图片或公式，确认后插入文稿。', icon: Image },
  { id: 'plot', label: '绘图', detail: '生成科研图形，批准后执行并查看产物。', icon: BarChart3 },
  { id: 'review', label: '论文评审', detail: '评审当前文稿，逐项查看建议与修改。', icon: CheckCircle2 },
  { id: 'collab', label: '协作', detail: '管理协作连接、邀请和共享编辑状态。', icon: Users }
] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number]['id'];
export function isWorkspaceTool(value: string | null): value is WorkspaceTool {
  return WORKSPACE_TOOLS.some(tool => tool.id === value);
}
export function workspaceToolHref(projectId: string, tool: WorkspaceTool) {
  return `/editor/${encodeURIComponent(projectId)}?tool=${tool}`;
}
