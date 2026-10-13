import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelEnvironment, listEnvironments, prepareEnvironment, retryEnvironment, type EnvironmentPackage, type EnvironmentState } from '../../../api/environmentAdapter';
import './pythonEnvironment.css';

interface PythonEnvironmentPanelProps {
  projectId: string;
  value?: string;
  disabled?: boolean;
  onChange: (environmentId: string) => void;
}
const statusLabels = { queued: '等待准备', preparing: '准备中', ready: '可以使用', failed: '准备失败', cancelled: '已取消', interrupted: '准备已中断' };
const active = (status: string) => status === 'queued' || status === 'preparing';

export function PythonEnvironmentPanel({ projectId, value = '', disabled = false, onChange }: PythonEnvironmentPanelProps) {
  const [state, setState] = useState<EnvironmentState | null>(null);
  const [packagesText, setPackagesText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const readVersion = useRef(0);
  const refresh = useCallback(async (signal: AbortSignal) => {
    const version = ++readVersion.current;
    try {
      const result = await listEnvironments(projectId, signal);
      if (!signal.aborted && version === readVersion.current) { setState(result); setError(''); }
    } catch (cause) {
      if (!signal.aborted && version === readVersion.current) setError(cause instanceof Error ? cause.message : '环境记录读取失败。');
    } finally { if (!signal.aborted && version === readVersion.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setState(null); setLoading(true); setError(''); setBusy(false); setPackagesText('');
    void refresh(controller.signal);
    return () => { controller.abort(); readVersion.current += 1; };
  }, [refresh]);
  const hasActiveJobs = state?.jobs.some(job => active(job.status)) ?? false;
  useEffect(() => {
    if (!hasActiveJobs) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted || stopped) return;
      await refresh(signal);
      if (!stopped && !signal.aborted) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [hasActiveJobs, refresh]);
  async function act(action: (signal: AbortSignal) => Promise<unknown>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true); setError('');
    try { await action(signal); await refresh(signal); }
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : '环境操作失败。'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  function prepare(standardLibrary: boolean) {
    const packages: EnvironmentPackage[] = [];
    if (!standardLibrary) {
      for (const [index, line] of packagesText.split('\n').entries()) {
        if (!line.trim()) continue;
        const match = line.trim().match(/^(\S+\.whl)\s+([a-f0-9]{64})$/);
        if (!match) { setError(`第 ${index + 1} 行需要 wheel 文件路径和 64 位小写 SHA-256，以空格分隔。`); return; }
        packages.push({ path: match[1], sha256: match[2] });
      }
      if (!packages.length) { setError('填写已取得的依赖文件，或选择“准备标准库环境”。'); return; }
    }
    void act(signal => prepareEnvironment(projectId, packages, signal));
  }
  const readyJobs = state?.jobs.filter(job => job.status === 'ready' && job.environment) || [];
  const selectedAvailable = !value || readyJobs.some(job => job.environment?.id === value);
  return (
    <section className="research-panel python-environment-panel" aria-busy={loading || busy}>
      <div className="research-panel-heading">
        <div><span className="research-overline">PYTHON ENVIRONMENT</span><h3>实验环境</h3></div>
        <button type="button" className="research-button research-button-quiet" disabled={busy || loading} onClick={() => { const signal = lifetime.current?.signal; if (signal) void refresh(signal); }}>刷新环境</button>
      </div>
      <p className="research-panel-copy">先准备独立的 Python 环境，再将它绑定到实验计划。准备环境和启动实验分别记录。</p>
      {loading && <p role="status" className="research-panel-copy">正在读取环境记录…</p>}
      {error && <div role="alert" className="research-callout research-callout-warning"><p>{error}</p></div>}
      {state && <>
        <p className="research-panel-copy">本地环境：{state.capability.local.available ? '可准备' : state.capability.local.reason || '暂不可用'}。容器和远程环境暂不可用。</p>
        <div className="research-form-grid">
          <label className="research-field research-field-wide">
            <span>本次实验使用的环境</span>
            <select value={value} disabled={disabled || busy} onChange={event => onChange(event.target.value)}>
              <option value="">未选择（沿用服务器配置）</option>
              {!selectedAvailable && <option value={value}>原环境暂不可用 · {value}</option>}
              {readyJobs.map(job => <option key={job.id} value={job.environment!.id}>Python {job.environment!.python.version} · {job.environment!.packages.length} 个依赖 · {job.environment!.id.slice(-12)}</option>)}
            </select>
          </label>
          {!selectedAvailable && <div className="research-callout research-callout-warning research-field-wide"><p>绑定的环境当前未就绪，请刷新记录或重新选择。</p></div>}
          <label className="research-field research-field-wide">
            <span>本地依赖文件 <small>每行：项目内 .whl 路径 SHA-256</small></span>
            <textarea rows={3} value={packagesText} disabled={disabled || busy} placeholder="wheels/package.whl 文件的64位SHA-256" onChange={event => setPackagesText(event.target.value)} />
            <small>使用已取得并核对的文件。缺少依赖时会保留错误日志，便于补齐后重试。</small>
          </label>
        </div>
        <div className="research-inline-actions python-environment-actions">
          <button type="button" className="research-button research-button-primary" disabled={disabled || busy || !state.capability.local.available} onClick={() => prepare(true)}>准备标准库环境</button>
          <button type="button" className="research-button research-button-quiet" disabled={disabled || busy || !state.capability.local.available || !packagesText.trim()} onClick={() => prepare(false)}>按依赖文件准备</button>
        </div>
        {!state.jobs.length && <p className="research-empty-inline">还没有环境记录。只需 Python 标准库的实验可以直接准备。</p>}
        <div className="python-environment-jobs">{state.jobs.map(job => (
          <article key={job.id} className="python-environment-job">
            <div className="python-environment-job-heading">
              <div><strong>{statusLabels[job.status]}</strong><small>{job.id}</small></div>
              <div className="research-inline-actions">
                {job.status === 'ready' && job.environment && <button type="button" className="research-button research-button-quiet" disabled={disabled || busy || value === job.environment.id} onClick={() => onChange(job.environment!.id)}>{value === job.environment.id ? '已绑定计划' : '绑定到计划'}</button>}
                {active(job.status) && <button type="button" className="research-button research-button-quiet" disabled={disabled || busy} onClick={() => void act(signal => cancelEnvironment(projectId, job.id, signal))}>取消准备</button>}
                {['failed', 'cancelled', 'interrupted'].includes(job.status) && <button type="button" className="research-button research-button-quiet" disabled={disabled || busy || !state.capability.local.available} onClick={() => void act(signal => retryEnvironment(projectId, job.id, signal))}>重试准备</button>}
              </div>
            </div>
            {job.environment && <dl className="research-run-summary">
              <div><dt>Python</dt><dd>{job.environment.python.version} · {job.environment.python.implementation}</dd></div>
              <div><dt>隔离方式</dt><dd>{job.environment.isolation}</dd></div>
              <div><dt>计算机</dt><dd>{job.environment.hardware.platform} / {job.environment.hardware.arch} · {job.environment.hardware.cpuCount} 核</dd></div>
              <div><dt>环境版本</dt><dd>{job.environment.sha256.slice(0, 16)}</dd></div>
            </dl>}
            {job.environment?.packages.length ? <p className="research-panel-copy">依赖：{job.environment.packages.map(pkg => `${pkg.name} ${pkg.version}`).join('、')}</p> : null}
            {job.error && <p className="python-environment-error">{job.error.message}</p>}
            {(job.logs?.stdout || job.logs?.stderr) && <details className="python-environment-logs"><summary>查看准备日志</summary><pre>{[job.logs.stdout, job.logs.stderr].filter(Boolean).join('\n')}</pre></details>}
          </article>
        ))}</div>
      </>}
    </section>
  );
}
