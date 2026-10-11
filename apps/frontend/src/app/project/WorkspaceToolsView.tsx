import { Link } from 'react-router-dom';
import { WORKSPACE_TOOLS, workspaceToolHref } from '../components/workspaceTools';
import { researchHref } from '../research/researchLocation';

export function WorkspaceToolsView({ projectId }: { projectId: string }) {
  return <>
    <div className="hub-page-heading"><div><h2>工具执行</h2><p>选择工具，使用当前项目文件与研究上下文。</p></div><Link className="hub-small-button" to={researchHref(projectId)}>继续当前工作</Link></div>
    <div className="hub-tools-grid">{WORKSPACE_TOOLS.map(tool => <Link key={tool.id} className="hub-tool-entry" to={workspaceToolHref(projectId, tool.id)}><tool.icon size={20} aria-hidden="true" /><div><strong>{tool.label}</strong><p>{tool.detail}</p></div><span aria-hidden="true">→</span></Link>)}</div>
    <section className="hub-panel"><h3>模板与文稿</h3><p className="hub-muted">迁移到期刊模板，或查看文稿质量和引用检查。</p><div className="hub-tool-actions"><Link className="hub-small-button" to={`/projects?action=transfer&project=${encodeURIComponent(projectId)}`}>模板迁移</Link><Link className="hub-small-button" to={`/project/${encodeURIComponent(projectId)}/quality`}>写作检查</Link></div></section>
  </>;
}
