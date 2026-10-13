import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listCodePreparations, prepareCode, type CodePreparation } from '../../../api/codePreparationAdapter';
import { getHarnessRun, listHarnessRuns, type HarnessRun } from '../../../api/harnessAdapter';
import { taskHref } from '../../project/taskLocation';

interface CodePreparationPanelProps {
  projectId: string;
  value?: string;
  entrypoint?: string;
  disabled?: boolean;
  onChange: (id: string | undefined, entrypoint?: string, adapter?: 'node' | 'python') => void;
}
const executable = (file: string) => /\.(?:py|mjs|js|cjs)$/i.test(file);
const adapterFor = (file: string): 'node' | 'python' => /\.py$/i.test(file) ? 'python' : 'node';
const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

export function CodePreparationPanel({ projectId, value = '', entrypoint = '', disabled = false, onChange }: CodePreparationPanelProps) {
  const [preparations, setPreparations] = useState<CodePreparation[]>([]);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [source, setSource] = useState<HarnessRun | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const readVersion = useRef(0);
  const sourceVersion = useRef(0);
  const refresh = useCallback(async (signal: AbortSignal) => {
    const version = ++readVersion.current;
    setLoading(true);
    try {
      const [versions, history] = await Promise.all([
        listCodePreparations(projectId, signal), listHarnessRuns(projectId, { status: 'completed', limit: '100' })
      ]);
      if (signal.aborted || version !== readVersion.current) return;
      setPreparations(versions.preparations);
      setRuns(history.runs.filter(run => run.projectId === projectId && run.status === 'completed' && run.adapter === 'deepseek' && run.kind !== 'research-coordinator'));
      setError('');
    } catch (cause) {
      if (!signal.aborted && version === readVersion.current) setError(message(cause, '代码版本或来源记录读取失败。'));
    } finally {
      if (!signal.aborted && version === readVersion.current) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setPreparations([]); setRuns([]); setSourceId(''); setSource(null); setPaths([]);
    setError(''); setBusy(false); setSourceLoading(false);
    void refresh(controller.signal);
    return () => { controller.abort(); readVersion.current += 1; sourceVersion.current += 1; };
  }, [refresh]);
  useEffect(() => {
    const version = ++sourceVersion.current;
    const signal = lifetime.current?.signal;
    setSource(null); setPaths([]); setSourceLoading(Boolean(sourceId));
    if (!sourceId || !signal || signal.aborted) return;
    void getHarnessRun(projectId, sourceId).then(({ run }) => {
      if (signal.aborted || version !== sourceVersion.current) return;
      if (run.projectId !== projectId || run.id !== sourceId || run.status !== 'completed' || run.adapter !== 'deepseek') {
        throw new Error('来源记录已经变化，请重新选择已完成的 DeepSeek 任务。');
      }
      setSource(run);
    }).catch(cause => {
      if (!signal.aborted && version === sourceVersion.current) setError(message(cause, '来源提案读取失败。'));
    }).finally(() => {
      if (!signal.aborted && version === sourceVersion.current) setSourceLoading(false);
    });
  }, [projectId, sourceId]);

  const selected = preparations.find(item => item.id === value);
  const entrypoints = selected?.files.filter(file => executable(file.path)).map(file => file.path) || [];
  const entrypointAvailable = entrypoints.includes(entrypoint);
  const candidates = [...new Set(source?.patches?.filter(patch => !patch.deleted && executable(patch.path)).map(patch => patch.path) || [])];
  const locked = disabled || busy || loading;
  function selectVersion(id: string, versions = preparations) {
    if (!id) { onChange(undefined); return; }
    const preparation = versions.find(item => item.id === id);
    const first = preparation?.files.find(file => executable(file.path))?.path;
    if (!preparation || preparation.status !== 'ready' || !first) { setError('这个代码版本没有可运行的入口，请刷新或重新准备。'); return; }
    onChange(id, first, adapterFor(first));
  }
  async function prepare() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked || sourceLoading || !source || !paths.length) return;
    setBusy(true); setError('');
    try {
      const { preparation } = await prepareCode(projectId, source.id, paths, signal);
      if (signal.aborted) return;
      if (preparation.projectId !== projectId || preparation.status !== 'ready' || preparation.source.runId !== source.id) {
        throw new Error('服务返回的代码版本与当前来源不符。');
      }
      const versions = await listCodePreparations(projectId, signal);
      if (signal.aborted) return;
      if (!versions.preparations.some(item => item.id === preparation.id)) throw new Error('准备结果尚未出现在代码版本记录中，请刷新核对。');
      setPreparations(versions.preparations);
      selectVersion(preparation.id, versions.preparations);
    } catch (cause) { if (!signal.aborted) setError(message(cause, '试跑代码准备失败。')); }
    finally { if (!signal.aborted) setBusy(false); }
  }

  return <section className="research-panel" aria-busy={loading || busy || sourceLoading}>
    <div className="research-panel-heading">
      <div><span className="research-overline">TRIAL CODE</span><h3>试跑代码</h3></div>
      <button type="button" className="research-button research-button-quiet" disabled={locked} onClick={() => { const signal = lifetime.current?.signal; if (signal) void refresh(signal); }}>刷新代码版本</button>
    </div>
    <p className="research-panel-copy">选择项目当前代码，或将已有 Agent 提案准备为固定版本，供隔离实验使用。</p>
    {loading && <p className="research-panel-copy" role="status">正在读取代码版本…</p>}
    {error && <div className="research-callout research-callout-warning" role="alert"><p>{error}</p></div>}
    <div className="research-form-grid">
      <label className="research-field research-field-wide"><span>本次实验使用的代码</span>
        <select value={value} disabled={locked} onChange={event => selectVersion(event.target.value)}>
          <option value="">项目当前代码</option>
          {value && !selected && <option value={value}>原代码版本暂不可用 · {value}</option>}
          {preparations.map(item => <option key={item.id} value={item.id}>固定版本 · {item.sha256.slice(0, 12)} · {item.files.length} 个文件</option>)}
        </select>
      </label>
      {value && !selected && !loading && <p className="research-field-wide research-panel-copy">绑定的代码版本当前不可用，请刷新或重新选择。</p>}
      {selected && <label className="research-field research-field-wide"><span>试跑入口</span>
        <select value={entrypoint} disabled={locked} onChange={event => { const file = event.target.value; onChange(selected.id, file, adapterFor(file)); }}>
          {!entrypointAvailable && <option value={entrypoint} disabled>{entrypoint ? `计划入口不在该版本中 · ${entrypoint}` : '计划尚未选择入口'}</option>}
          {entrypoints.map(file => <option key={file} value={file}>{file}</option>)}
        </select>
      </label>}
      {selected && !entrypointAvailable && <div className="research-field-wide research-callout research-callout-warning" role="alert"><p>实际计划入口{entrypoint ? `“${entrypoint}”不属于所选代码版本` : '为空'}，请选择这个版本中的可运行入口。</p></div>}
    </div>
    {selected && <>
      <p className="research-panel-copy">已准备 · 执行结果见运行记录 · {selected.files.length} 个文件</p>
      <dl className="research-run-summary"><div><dt>代码 SHA-256</dt><dd>{selected.sha256}</dd></div></dl>
      <div className="research-inline-actions">
        <Link to={taskHref(projectId, `harness:${selected.source.runId}`)}>DeepSeek 来源任务</Link>
        {selected.source.childRunIds.map((id, index) => <Link key={id} to={taskHref(projectId, `harness:${id}`)}>Codex worker {index + 1}</Link>)}
      </div>
    </>}
    <details>
      <summary>从已有提案准备代码</summary>
      <p className="research-panel-copy">选择已完成任务中的代码文件。服务会核对真实 Codex 来源和文件版本；准备结果仍需实际试跑。</p>
      <label className="research-field"><span>来源 DeepSeek 任务</span>
        <select value={sourceId} disabled={locked} onChange={event => { sourceVersion.current += 1; setSource(null); setPaths([]); setError(''); setSourceId(event.target.value); }}>
          <option value="">选择已完成任务</option>
          {runs.map(run => <option key={run.id} value={run.id}>{run.stage || '任务'} · {run.task} · {run.id.slice(0, 8)}</option>)}
        </select>
      </label>
      {sourceLoading && <p className="research-panel-copy" role="status">正在读取代码提案…</p>}
      {source && <>
        <p><Link to={taskHref(projectId, `harness:${source.id}`)}>查看来源与提案</Link></p>
        {candidates.length ? <fieldset disabled={locked || sourceLoading}><legend>准备哪些代码文件</legend>
          {candidates.map(file => <label key={file} className="research-field"><span><input type="checkbox" checked={paths.includes(file)} onChange={event => setPaths(current => event.target.checked ? [...current, file] : current.filter(path => path !== file))} /> {file}</span></label>)}
        </fieldset> : <p className="research-panel-copy">这个任务没有可准备的 Python 或 Node 代码提案。</p>}
      </>}
      {!loading && !runs.length && <p className="research-empty-inline">还没有可选择的已完成 DeepSeek 任务。</p>}
      <button type="button" className="research-button research-button-primary" disabled={locked || sourceLoading || !source || !paths.length} onClick={() => void prepare()}>准备试跑代码</button>
    </details>
  </section>;
}
