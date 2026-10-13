import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HarnessRun, RuntimeEvent } from '../../api/client';
import { taskHref } from './taskLocation';

function EventBody({ event }: { event: RuntimeEvent }) {
  return <><dl className="hub-detail-list"><div><dt>事件 / 尝试</dt><dd>{event.id || '旧记录未保存 ID'} / {event.attempt ?? '未记录'}</dd></div><div><dt>调用 / 能力</dt><dd>{event.callId || '未记录'} / {event.capability || '未记录'}</dd></div></dl>{event.truncated && <p className="hub-muted">此事件详情已按大小上限截断。</p>}{event.arguments !== undefined && <><h4>参数</h4><pre className="task-record">{event.arguments}</pre></>}{event.output !== undefined && <><h4>工具输出</h4><pre className="task-record">{event.output}</pre></>}{event.error && <pre className="task-record">{event.error}</pre>}{event.text && <pre className="task-record">{event.text}</pre>}{event.path && <p>实际读取：<code>{event.path}</code> · {event.version?.sha256 || '版本未记录'}</p>}{event.usage && <pre className="task-record">供应商报告用量：{JSON.stringify(event.usage,null,2)}</pre>}</>;
}
export function RuntimeEventsView({ run }: { run: HarnessRun }) {
  const [limit, setLimit] = useState(100);
  const events = run.events || [];
  return <div className="runtime-events">
    <p className="hub-muted">保留 {events.length} 条事件。{run.eventRetention ? `累计 ${run.eventRetention.total} 条 · 已丢弃 ${run.eventRetention.dropped} 条 · 上限 ${run.eventRetention.limit} 条。` : '旧记录未保存完整保留范围。'}{run.eventRetention?.priorRetentionUnknown && '早期保留范围未知。'}</p>
    {events.slice(0,limit).map((event,index) => <details key={event.id || `${index}:${event.type}`} className="runtime-event"><summary><code>{event.sequence ?? '—'}</code><strong>{event.type || '未记录类型'}</strong><span>{event.name || event.path || ''}</span><small>{event.at || '时间未记录'}</small></summary><EventBody event={event} /></details>)}
    {events.length > limit && <button className="hub-small-button is-quiet" onClick={() => setLimit(value => value + 100)}>显示更多事件（剩余 {events.length - limit}）</button>}
  </div>;
}
export function RuntimeToolCalls({ run }: { run: HarnessRun }) {
  const experiments = [...new Map((run.events || []).filter(event => event.type === 'research/experiment' && event.experimentRunId)
    .map(event => [event.experimentRunId, event])).values()];
  const searches = [...new Map((run.events || []).filter(event => event.type === 'research/search' && event.searchSessionId)
    .map(event => [event.searchSessionId, event])).values()];
  const calls = new Map<string, { start?: RuntimeEvent; end?: RuntimeEvent }>();
  for (const event of run.events || []) {
    if (!event.type?.startsWith('tool/') || !event.callId) continue;
    const key = `${event.attempt ?? 'unknown'}:${event.callId}`;
    const pair = calls.get(key) || {};
    if (['tool/start','tool/call'].includes(event.type)) pair.start = event;
    else if (['tool/end','tool/error','tool/result'].includes(event.type)) pair.end = event;
    calls.set(key,pair);
  }
  return <div className="runtime-calls">{!!experiments.length && <section><h3>关联实验结果</h3>{experiments.map(event => <p key={event.experimentRunId}><Link to={taskHref(run.projectId,`experiment-run:${event.experimentRunId}`)}>{event.experimentRunId}</Link> · {event.experimentStatus === 'completed' ? '执行完成' : event.experimentStatus === 'cancelled' ? '已取消' : '执行失败'}</p>)}<p className="hub-muted">查看实际日志、指标和产物。执行完成不等于科学结论已核验。</p></section>}{!!searches.length && <section><h3>已保存的论文检索</h3>{searches.map(event => <p key={event.searchSessionId}><Link to={`/project/${encodeURIComponent(run.projectId)}/papers/search?${new URLSearchParams({ q: event.searchQuery || '', search: event.searchSessionId! })}`}>{event.searchQuery || '查看检索结果'}</Link> · {{ completed: '已完成', partial: '部分来源可用', failed: '来源请求失败' }[event.searchStatus || 'failed']}</p>)}<p className="hub-muted">检索结果保留来源与筛选条件，尚未作为科学证据确认。</p></section>}<h3>工具调用 · {calls.size} 组已记录 ID</h3>{!calls.size && <p className="hub-muted">没有可关联的调用记录；不能据此判断工具从未使用。</p>}{Array.from(calls).map(([id,pair]) => <details className="runtime-event" key={id}><summary><strong>{pair.start?.name || pair.end?.name || '工具名未记录'}</strong><span>{pair.end ? pair.end.outcome === 'error' ? '错误' : '已返回' : '未记录结束'}</span><code>{id}</code></summary>{!pair.start && <p className="hub-muted">开始记录未保留，无法完整还原此调用。</p>}{pair.start && <EventBody event={pair.start} />}{pair.end && <EventBody event={pair.end} />}</details>)}</div>;
}
