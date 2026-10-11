import { FileText, Flag, FlaskConical, GitBranch, Lightbulb, Terminal, Wrench } from 'lucide-react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ExplorationNode } from '../../api/explorationAdapter';

export const NODE_META = {
  stage: { label: '项目阶段', color: '#6366a4', icon: Flag },
  harness: { label: '任务', color: '#2563eb', icon: GitBranch },
  call: { label: '工具调用', color: '#0e7490', icon: Wrench },
  experiment: { label: '实验', color: '#7c3aed', icon: FlaskConical },
  artifact: { label: '产物', color: '#b45309', icon: Terminal },
  evidence: { label: '证据材料', color: '#15803d', icon: FileText },
  claim: { label: '主张', color: '#be123c', icon: Lightbulb },
};
export const RELATION_META: Record<string, { label: string; color: string }> = {
  delegates: { label: '委派', color: '#15803d' }, replays: { label: '重放', color: '#64748b' },
  runs: { label: '执行', color: '#15803d' }, calls: { label: '调用', color: '#7c3aed' },
  references: { label: '引用', color: '#0e7490' }, reports: { label: '报告', color: '#b45309' },
  produces: { label: '产出', color: '#b45309' }, contradicts: { label: '反例', color: '#be123c' },
  supports: { label: '支持', color: '#15803d' },
};
const STATUS_LABELS: Record<string, string> = {
  pending: '待处理', queued: '排队中', running: '运行中', completed: '已完成', failed: '失败',
  cancelled: '已取消', paused: '已暂停', approved: '已批准', rejected: '已拒绝', draft: '草稿',
  unverified: '未核验', unsupported: '缺少支持', 'stale-reference': '旧版本引用',
  'human-confirmed': '人工确认', 'missing-source': '来源缺失', archived: '已归档',
};
export const statusLabel = (status: string) => STATUS_LABELS[status] || status;
export const nodeMeta = (kind: string) => NODE_META[kind as keyof typeof NODE_META] || NODE_META.artifact;
export type ExplorationFlowNode = Node<{ record: ExplorationNode; select: (id: string) => void }, 'record'>;
export function ExplorationRecord({ data, selected }: NodeProps<ExplorationFlowNode>) {
  const record = data.record, meta = nodeMeta(record.kind), Icon = meta.icon;
  return <div className={`exploration-node ${selected ? 'is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="exploration-node-heading"><span className="exploration-type-icon" style={{ color: meta.color, backgroundColor: `${meta.color}12` }}><Icon size={15} aria-hidden="true" /></span><strong>{meta.label}</strong><small title={String(record.version ?? '')}>{record.retention === 'summary' ? '归档' : record.version != null ? `v${String(record.version).slice(0,8)}` : ''}</small></div>
    <button className="nodrag exploration-node-title" title={record.title} onClick={() => data.select(record.id)}>{record.title}</button>
    <div className="exploration-node-footer"><span className={`exploration-status is-${record.status}`}><i aria-hidden="true" />{record.kind==='stage' && record.status==='pending' ? '待开始' : statusLabel(record.status)}</span><code title={record.id}>{record.id.slice(-8)}</code></div>
    <Handle type="source" position={Position.Right} />
  </div>;
}
