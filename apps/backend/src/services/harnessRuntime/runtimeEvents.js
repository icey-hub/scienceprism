import { capabilityForToolName } from './capabilities.js';
export const MAX_RUNTIME_EVENTS = 1000;
const SECRET_KEY = /api.?key|authorization|password|secret|cookie|access.?token|refresh.?token/i;
const USAGE_KEYS = ['input','inputTokens','promptTokens','prompt_tokens','output','outputTokens','completionTokens','completion_tokens','total','totalTokens','total_tokens','cacheReadTokens','cacheWriteTokens'];
function scrub(value, state, depth = 0) {
  if (depth > 6) { state.truncated = true; return '[depth limit]'; }
  if (Array.isArray(value)) { if (value.length > 100) state.truncated = true; return value.slice(0, 100).map(item => scrub(item, state, depth + 1)); }
  if (value && typeof value === 'object') { const entries = Object.entries(value); if (entries.length > 100) state.truncated = true; return Object.fromEntries(entries.slice(0, 100).map(([key,item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : scrub(item, state, depth + 1)])); }
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"']+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]');
  return value;
}
function bounded(value, limit, state) {
  if (value === undefined || value === null) return undefined;
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { /* Plain tool output. */ } }
  const safe = scrub(parsed, state);
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
  if (text.length <= limit) return text;
  state.truncated = true;
  return text.slice(0, limit) + '\n[truncated]';
}
function messageText(message) { return message?.content?.filter(block => block?.type === 'text').map(block => block.text).join(''); }
export function summarizeEvent(event = {}) {
  const source = event?.params?.event || event;
  const data = source?.data || source || {};
  const state = { truncated: false };
  const type = source.type || event.method || 'unknown';
  const name = data.name || (typeof data.tool === 'string' ? data.tool : data.tool?.name);
  const usage = data.usage || data.tokenUsage;
  const sourceTime = source.at || source.time;
  const time = sourceTime !== undefined && Number.isFinite(new Date(sourceTime).getTime()) ? new Date(sourceTime).toISOString() : null;
  return {
    schemaVersion: 1, type,
    name: name ? String(name).slice(0, 256) : undefined,
    callId: String(data.callId || data.message?.toolCallId || data.message?.source?.callId || '').slice(0,256) || undefined,
    capability: capabilityForToolName(name),
    usage: usage && typeof usage === 'object' ? Object.fromEntries(USAGE_KEYS.filter(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]])) : undefined,
    arguments: bounded(data.arguments ?? data.input, 4000, state),
    output: bounded(data.output ?? (type === 'tool/result' ? messageText(data.message) : undefined), 8000, state),
    error: bounded(data.error || (type === 'tool/error' ? data.reason : undefined), 2000, state),
    outcome: ['tool/error'].includes(type) || data.message?.isError ? 'error' : ['tool/end','tool/result'].includes(type) ? 'success' : undefined,
    ...(type === 'file/read' ? { path: typeof data.path === 'string' ? data.path.slice(0,2048) : undefined, version: data.version ? { exists: data.version.exists, sha256: typeof data.version.sha256 === 'string' ? data.version.sha256.slice(0,64) : null } : undefined,
      skillSource: data.skillSource ? { skillName: String(data.skillSource.skillName || '').slice(0,128), source: data.skillSource.source,
        sourceRelativePath: String(data.skillSource.sourceRelativePath || '').slice(0,2048), versionId: data.skillSource.versionId || null,
        sha256: String(data.skillSource.sha256 || '').slice(0,64), bytes: data.skillSource.bytes } : undefined } : {}),
    ...(type === 'tool/policy' ? { decision: ['allow', 'deny'].includes(data.decision) ? data.decision : undefined,
      actor: ['human', 'system'].includes(data.actor) ? data.actor : undefined,
      policyVersion: String(data.policyVersion || '').slice(0,128), reasonCode: typeof data.reasonCode === 'string' ? data.reasonCode.slice(0,128) : undefined,
      path: typeof data.path === 'string' ? data.path.slice(0,2048) : undefined } : {}),
    text: type === 'assistant/message' ? bounded(data.text ?? messageText(data.message), 16000, state) : undefined,
    ...(type === 'runtime/fallback' ? { from: data.from, to: data.to, error: bounded(data.error,2000,state) } : {}),
    ...(type === 'runtime/delegation' ? { childRunId: String(data.childRunId || '').slice(0,100), parentRunId: String(data.parentRunId || '').slice(0,100),
      runtime: data.runtime === 'codex' ? 'codex' : undefined, phase: ['started', 'completed', 'failed', 'cancelled'].includes(data.phase) ? data.phase : undefined } : {}),
    ...(type === 'research/search' ? { searchSessionId: String(data.searchSessionId || '').slice(0,100),
      searchQuery: typeof (data.criteria?.query ?? data.searchQuery) === 'string' ? (data.criteria?.query ?? data.searchQuery).slice(0,1000) : undefined,
      searchStatus: ['completed', 'partial', 'failed'].includes(data.status ?? data.searchStatus) ? (data.status ?? data.searchStatus) : undefined } : {}),
    sourceSequence: Number.isSafeInteger(source.seq) ? source.seq : undefined,
    at: time || new Date().toISOString(), truncated: state.truncated
  };
}
export function appendRuntimeEvents(run, summaries) {
  let sequence = run.eventRetention?.total ?? run.events?.at(-1)?.sequence ?? run.events?.length ?? 0;
  const priorRetentionUnknown = run.eventRetention?.priorRetentionUnknown ?? Boolean(run.events?.length && !run.eventRetention);
  const events = [...(run.events || [])];
  for (const summary of summaries) {
    const event = { ...summary, runId: run.id, attempt: run.attempt || 0, sequence: ++sequence, id: `${run.id}:${sequence}` };
    if (event.callId && !event.name) {
      const start = [...events].reverse().find(prior => prior.callId === event.callId && prior.attempt === event.attempt && prior.name);
      if (start) { event.name = start.name; event.capability = start.capability; }
    }
    events.push(event);
  }
  run.events = events.slice(-MAX_RUNTIME_EVENTS);
  run.eventRetention = { limit: MAX_RUNTIME_EVENTS, total: sequence, retained: run.events.length, dropped: Math.max(0, sequence - run.events.length), priorRetentionUnknown };
  return run;
}
export function sumEventUsage(events = []) {
  const reports = events.map(event => summarizeEvent(event).usage).filter(usage => usage && Object.keys(usage).length);
  if (!reports.length) return null;
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const usage of reports) {
    const input = usage.inputTokens ?? usage.input ?? usage.promptTokens ?? usage.prompt_tokens ?? 0;
    const output = usage.outputTokens ?? usage.output ?? usage.completionTokens ?? usage.completion_tokens ?? 0;
    const cacheRead = usage.cacheReadTokens || 0, cacheWrite = usage.cacheWriteTokens || 0;
    total.inputTokens += input; total.outputTokens += output;
    total.cacheReadTokens += cacheRead; total.cacheWriteTokens += cacheWrite;
    total.totalTokens += usage.totalTokens ?? usage.total ?? usage.total_tokens ?? input + output + cacheRead + cacheWrite;
  }
  return total;
}
