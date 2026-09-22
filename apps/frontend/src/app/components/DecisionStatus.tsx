const LABELS: Record<string, string> = {
  suggested: 'AI 建议',
  awaiting_approval: '人工确认',
  pending: '待确认',
  accepted: '已应用',
  applied: '已应用',
  rejected: '已拒绝',
  expired: '已过期',
  completed: '已完成',
  failed: '失败',
  running: '运行中',
  cancelled: '已取消',
  paused: '已暂停',
  created: '待启动'
};

export function DecisionStatus({ status }: { status: string }) {
  const label = LABELS[status] || status;
  return <span className={`decision-status is-${status.replace(/[^a-z0-9_-]/gi, '-')}`}>{label}</span>;
}

export function statusText(status: string) {
  return LABELS[status] || status;
}
