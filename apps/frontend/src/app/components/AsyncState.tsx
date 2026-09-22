import type { ReactNode } from 'react';

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return <div className="workbench-state is-loading" role="status"><span className="workbench-spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="workbench-state is-error" role="alert"><strong>读取失败</strong><span>{message}</span>{onRetry && <button type="button" onClick={onRetry}>重新加载</button>}</div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="workbench-state is-empty"><strong>{title}</strong><span>{detail}</span>{action}</div>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return <div className="workbench-progress" aria-label={label || `${normalized}%`}><span style={{ width: `${normalized}%` }} /></div>;
}
