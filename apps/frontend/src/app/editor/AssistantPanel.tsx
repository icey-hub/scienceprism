import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HarnessRun } from '../../api/assistantAdapter';
import { ConstraintProposalPanel } from './ConstraintProposalPanel';
import type { useAssistantRun } from './useAssistantRun';

export type AssistantIntent = { prompt: string; task: string; permission: 'read' | 'edit'; selection?: string };

type Props = {
  projectId: string;
  assistant: ReturnType<typeof useAssistantRun>;
  activePath: string;
  selection: string;
  onSend: (intent: AssistantIntent) => Promise<boolean>;
  onRetry: (run: HarnessRun) => void;
  onReview: () => void;
};

export function AssistantPanel({ projectId, assistant, activePath, selection, onSend, onRetry, onReview }: Props) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [permission, setPermission] = useState<'read' | 'edit'>('edit');
  const [task, setTask] = useState('polish');
  const [target, setTarget] = useState('English');
  const [scope, setScope] = useState('selection');
  const statusLabel: Record<string, string> = {
    created: t('等待启动'), running: t('运行中'), paused: t('已暂停'),
    completed: t('已完成'), failed: t('失败'), cancelled: t('已停止')
  };
  const submit = async () => {
    let instruction = prompt.trim();
    let selected = selection;
    if (permission === 'edit' && task === 'translate') {
      instruction = `Translate ${scope === 'project' ? 'the project .tex files' : scope === 'file' ? 'the current file' : 'the selected text'} to ${target}. Preserve LaTeX commands and structure. ${instruction}`;
      if (scope !== 'selection') selected = '';
    }
    if (await onSend({ prompt: instruction || t('润色当前文稿，保留含义和术语。'), task: permission === 'read' ? 'custom' : task, permission, selection: selected })) setPrompt('');
  };
  const proposalCount = assistant.runs.filter((run) => run.constraintProposal).length;
  return <>
    <div className="panel-header"><div>{t('助手')}</div><button className="btn ghost" onClick={onReview}>{t('审阅修改')}</button></div>
    <div className="context-tags"><span className="context-tag">{activePath || t('项目上下文')}</span>{selection && <span className="context-tag">{t('已选文本')}</span>}</div>
    <ConstraintProposalPanel projectId={projectId} refreshToken={proposalCount} />
    <div className="chat-messages" aria-label={t('助手任务历史')}>
      {assistant.loading && <div role="status">{t('正在恢复任务历史…')}</div>}
      {!assistant.loading && !assistant.runs.length && <div className="muted">{t('描述任务；修改会在审阅后应用。')}</div>}
      {[...assistant.runs].reverse().map((run) => <div key={run.id} className="assistant-run" data-run-id={run.id}>
        <div className="chat-msg user"><div className="role">{t('任务')}</div><div className="content">{run.request?.prompt || run.task}</div></div>
        <div className="chat-msg assistant">
          <div className="role" role="status">{statusLabel[run.status] || run.status}</div>
          {run.reply && <div className="content markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.reply}</ReactMarkdown></div>}
          {run.error && <div role="alert">{run.error.message} ({run.error.code})</div>}
          {run.constraintProposalError && <div role="status">{run.constraintProposalError.message}</div>}
          {(run.patches?.length || 0) > 0 && <button className="btn ghost" onClick={onReview}>{t('审阅修改')} ({run.patches?.length})</button>}
          {['failed', 'cancelled'].includes(run.status) && <button className="btn ghost" disabled={assistant.busy} onClick={() => onRetry(run)}>{t('用当前文稿重试')}</button>}
          <details>
            <summary>{t('任务与上下文详情')}</summary>
            <div className="muted">Run {run.id}</div>
            <div>{run.model} · {run.request?.permission === 'read' ? t('只读问答') : t('提出修改')}</div>
            <pre className="log-content">{JSON.stringify(run.contextManifest || {}, null, 2)}</pre>
            <ul>{(run.events || []).slice(-12).map((event, index) => <li key={index}>{event.type}{event.name ? ` · ${event.name}` : ''}</li>)}</ul>
          </details>
        </div>
      </div>)}
    </div>
    <div className="chat-controls">
      {assistant.error && <div role="alert">{assistant.error}</div>}
      <label>{t('权限')}<select className="input" value={permission} onChange={(event) => setPermission(event.target.value as 'read' | 'edit')}>
        <option value="edit">{t('提出修改')}</option><option value="read">{t('只读问答')}</option>
      </select></label>
      {permission === 'edit' && <label>{t('任务')}<select className="input" value={task} onChange={(event) => setTask(event.target.value)}>
        <option value="polish">{t('润色')}</option><option value="rewrite">{t('改写')}</option><option value="translate">{t('翻译')}</option><option value="custom">{t('自定义')}</option>
      </select></label>}
      {permission === 'edit' && task === 'translate' && <div className="row">
        <label>{t('目标语言')}<input className="input" value={target} onChange={(event) => setTarget(event.target.value)} /></label>
        <label>{t('范围')}<select className="input" value={scope} onChange={(event) => setScope(event.target.value)}><option value="selection">{t('选区')}</option><option value="file">{t('当前文件')}</option><option value="project">{t('整个项目')}</option></select></label>
      </div>}
      <label>{t('任务描述')}<textarea className="input" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !assistant.busy) { event.preventDefault(); void submit(); }
      }} /></label>
      {assistant.activeRun ? <button className="btn full" disabled={assistant.stopping} onClick={() => void assistant.stop()}>{assistant.stopping ? t('正在停止…') : t('停止任务')}</button>
        : <button className="btn full" disabled={assistant.busy || (permission === 'read' && !prompt.trim()) || (permission === 'edit' && task === 'translate' && scope === 'selection' && !selection)} onClick={() => void submit()}>{assistant.starting ? t('保存并启动…') : t('发送')}</button>}
    </div>
  </>;
}
