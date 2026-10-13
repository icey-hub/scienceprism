import { normalizeSearchInput, searchProjectPapers } from '../paperSearch.js';
import { HarnessRuntimeError } from './errors.js';

const TOOL = 'research_search_papers';
const ENDPOINTS = Object.freeze({ arxiv: { host: 'export.arxiv.org', path: '/api/query' }, openalex: { host: 'api.openalex.org', path: '/works' } });
const fail = (code, message, status = 403) => new HarnessRuntimeError(status, code, message);
const short = (value, length = 200) => {
  if (typeof value !== 'string') return '';
  const bytes = Buffer.from(value); let end = Math.min(length, bytes.length);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
};
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function policySnapshot(value) {
  if (!value || !['projectId', 'runId', 'role', 'task'].every(key => typeof value[key] === 'string' && value[key] && value[key].length <= 200)
    || typeof value.active !== 'boolean' || !['auto', 'manual'].includes(value.mode)
    || !(typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 200 || typeof value.version === 'number' && Number.isFinite(value.version))) {
    throw fail('DSH_POLICY_UNAVAILABLE', 'The current research Run policy is invalid.');
  }
  const capabilities = {};
  for (const key of ['granted', 'allowedPaths', 'networkAllowlist']) {
    if (!Array.isArray(value.capabilities?.[key]) || value.capabilities[key].some(item => typeof item !== 'string')) throw fail('DSH_POLICY_UNAVAILABLE', 'The research capability policy is invalid.');
    capabilities[key] = Object.freeze([...value.capabilities[key]]);
  }
  return Object.freeze({ ...Object.fromEntries(['projectId', 'runId', 'role', 'task', 'active', 'mode', 'version'].map(key => [key, value[key]])), capabilities: Object.freeze(capabilities) });
}
function argumentsFor(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some(key => !['tool', 'callId', 'arguments'].includes(key))
    || call.tool !== TOOL || typeof call.callId !== 'string' || !call.callId || call.callId.length > 200 || /[\x00-\x1f\x7f]/.test(call.callId)) throw fail('DSH_ARGUMENTS_INVALID', 'A bounded research search tool identity is required.', 400);
  const input = call.arguments;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'sources', 'pageSize', 'offset', 'filters', 'ranking'].includes(key))) throw fail('DSH_ARGUMENTS_INVALID', 'Only paper search criteria are accepted.', 400);
  if (typeof input.query !== 'string' || !input.query.isWellFormed() || /[\x00-\x1f\x7f]/.test(input.query)
    || input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > 2 || input.sources.some(source => !Object.hasOwn(ENDPOINTS, source)))) throw fail('DSH_ARGUMENTS_INVALID', 'Use a bounded query and the fixed arXiv/OpenAlex sources.', 400);
  if (input.ranking !== undefined && (!input.ranking || typeof input.ranking !== 'object' || Array.isArray(input.ranking))
    || input.filters?.publicationType !== undefined && input.filters.publicationType !== null && typeof input.filters.publicationType !== 'string') throw fail('DSH_ARGUMENTS_INVALID', 'Search ranking and publication filters require their declared types.', 400);
  try { return normalizeSearchInput(input); }
  catch { throw fail('DSH_ARGUMENTS_INVALID', 'The paper search filters or pagination are invalid.', 400); }
}
function summary(session, criteria, projectId) {
  if (!session || session.projectId !== projectId || typeof session.id !== 'string' || !session.id || session.id.length > 200
    || !['completed', 'partial', 'failed'].includes(session.status) || !Array.isArray(session.candidates)
    || !Array.isArray(session.failures) || !Array.isArray(session.sourceResults)
    || JSON.stringify(normalizeSearchInput(session.criteria)) !== JSON.stringify(criteria)) throw fail('DSH_SEARCH_RESULT_INVALID', 'The persisted search session does not match this request.', 502);
  const result = { id: session.id, searchSessionId: session.id, projectId, createdAt: short(session.createdAt, 40), criteria, status: session.status,
    nextOffset: integer(session.nextOffset), candidateCount: session.candidates.length,
    candidates: session.candidates.slice(0, 40).map(candidate => ({ id: short(candidate.id), title: short(candidate.title, 800),
      abstract: short(candidate.abstract, 1200), authors: (Array.isArray(candidate.authors) ? candidate.authors : []).slice(0, 10).map(author => short(author, 120)),
      year: integer(candidate.year), venue: short(candidate.venue, 300), publicationType: short(candidate.publicationType, 40),
      doi: short(candidate.doi), arxivId: short(candidate.arxivId), source: short(candidate.source, 40), url: short(candidate.url, 2048),
      isOpenAccess: typeof candidate.isOpenAccess === 'boolean' ? candidate.isOpenAccess : null,
      rankingStatus: ['known', 'unknown'].includes(candidate.rankingStatus) ? candidate.rankingStatus : 'unknown',
      rankings: (Array.isArray(candidate.rankings) ? candidate.rankings : []).slice(0, 4).map(rank => ({ scheme: short(rank.scheme, 40),
        rank: short(rank.rank, 40), editionYear: integer(rank.editionYear), subject: short(rank.subject, 200), catalogId: short(rank.catalogId),
        scope: 'venue', provenance: { label: short(rank.provenance?.label, 120), url: short(rank.provenance?.url, 512) } })),
      searchSessionIds: [session.id], sourceRecords: (Array.isArray(candidate.sourceRecords) ? candidate.sourceRecords : []).slice(0, 4).map(record => ({
        provider: short(record.provider, 40), id: short(record.id), retrievedAt: short(record.retrievedAt, 40), searchSessionId: session.id, externalVersion: short(record.externalVersion) })) })),
    failures: session.failures.slice(0, 4).map(failure => ({ source: short(failure.source, 40), code: short(failure.code, 100), retryable: failure.retryable === true,
      message: 'This paper source could not complete the requested search.' })),
    sourceResults: session.sourceResults.slice(0, 4).map(source => ({ source: short(source.source, 40), retrievedAt: short(source.retrievedAt, 40), total: integer(source.total),
      received: integer(source.received), matched: integer(source.matched), filterMode: short(source.filterMode, 40) })),
    rankingCoverage: { catalogVersion: integer(session.rankingCoverage?.catalogVersion), total: integer(session.rankingCoverage?.total),
      matched: integer(session.rankingCoverage?.matched), unmatched: integer(session.rankingCoverage?.unmatched), returned: integer(session.rankingCoverage?.returned),
      catalogCount: integer(session.rankingCoverage?.catalogCount), scope: 'retrieved-batch',
      ratio: typeof session.rankingCoverage?.ratio === 'number' && session.rankingCoverage.ratio >= 0 && session.rankingCoverage.ratio <= 1 ? session.rankingCoverage.ratio : null,
      unmatchedPapers: (Array.isArray(session.rankingCoverage?.unmatchedPapers) ? session.rankingCoverage.unmatchedPapers : []).slice(0, 40)
        .map(paper => ({ id: short(paper.id), venue: short(paper.venue, 300), reason: short(paper.reason, 40) })) },
    resultSummary: { returned: Math.min(40, session.candidates.length), candidates: session.candidates.length, failedSources: session.failures.length },
    truncated: session.candidates.length > 40, evidenceConfirmed: false };
  // JSON escapes can grow even byte-capped strings. Reduce only the candidate
  // preview; the saved session, full criteria and source status stay available.
  while (result.candidates.length && Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) {
    result.candidates.pop(); result.truncated = true; result.resultSummary.returned = result.candidates.length;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw fail('DSH_SEARCH_RESULT_INVALID', 'The search result summary exceeds its controlled output limit.', 502);
  return result;
}

/** Search authority for one DSH Run. Transport and persistence remain with the
 * existing search service; these trusted hooks must guard its actual effects.
 * This broker never downloads papers, imports candidates, or writes a manuscript. */
export async function createDshResearchBroker({ readPolicy, onDecision, signal, search = searchProjectPapers, emit = () => {} } = {}) {
  if (typeof readPolicy !== 'function' || typeof onDecision !== 'function' || typeof search !== 'function' || typeof emit !== 'function') throw fail('DSH_POLICY_UNAVAILABLE', 'Current research policy and persisted decisions are required.');
  const ceiling = policySnapshot(await readPolicy());
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const calls = new Map(); let pending = Promise.resolve();
  const check = (policy, version) => {
    if (combined.aborted) throw fail('DSH_CANCELLED', 'The research search was cancelled.');
    if (!ceiling.active || !policy.active) throw fail('DSH_RUN_INACTIVE', 'The owning research Run is inactive.');
    if (['projectId', 'runId', 'role', 'task'].some(key => ceiling[key] !== policy[key])) throw fail('DSH_OWNER_CHANGED', 'The search does not belong to its bound Run, role and task.');
    if (ceiling.mode !== 'auto' || policy.mode !== 'auto') throw fail('DSH_APPROVAL_UNAVAILABLE', 'Manual search tools require a project approval channel.');
    if (![ceiling, policy].every(value => value.capabilities.granted.includes('research.search'))) throw fail('CAPABILITY_DENIED', 'This Run does not permit research search.');
    if (version !== undefined && policy.version !== version) throw fail('DSH_POLICY_CHANGED', 'The research policy changed during this search.');
  };
  const current = async version => { const policy = policySnapshot(await readPolicy()); check(policy, version); return policy; };
  const record = (callId, policy, decision, reasonCode) => onDecision({ type: 'tool/policy', tool: TOOL, callId, projectId: ceiling.projectId,
    runId: ceiling.runId, capability: 'research.search', actor: 'system', policyVersion: policy?.version ?? ceiling.version, decision, ...(reasonCode ? { reasonCode } : {}) });
  async function execute(entry) {
    let policy;
    try {
      policy = await current(); entry.version = policy.version;
      try { await record(entry.callId, policy, 'allow'); } catch { throw fail('DSH_AUDIT_UNAVAILABLE', 'The research policy decision could not be persisted.'); }
      await current(entry.version);
      const beforeRequest = async ({ source, url } = {}) => {
        const active = await current(entry.version); let endpoint;
        try { endpoint = new URL(url); } catch { throw fail('NETWORK_DENIED', 'The search transport requested an invalid endpoint.'); }
        const fixed = ENDPOINTS[source];
        if (!fixed || !entry.args.sources.includes(source) || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.hash
          || endpoint.hostname !== fixed.host || endpoint.pathname !== fixed.path
          || ![ceiling, active].every(value => value.capabilities.networkAllowlist.includes(fixed.host))) throw fail('NETWORK_DENIED', 'The search endpoint is outside this Run network scope.');
      };
      const beforePersist = async () => { await current(entry.version); };
      const session = await search(ceiling.projectId, entry.args, { signal: combined, beforeRequest, beforePersist });
      await current(entry.version);
      const result = summary(session, entry.args, ceiling.projectId);
      emit({ type: 'research/search', data: { name: TOOL, callId: entry.callId, searchSessionId: result.id, projectId: ceiling.projectId,
        criteria: result.criteria, status: result.status, sourceResults: result.sourceResults, failures: result.failures, resultSummary: result.resultSummary, evidenceConfirmed: false } });
      return result;
    } catch (reason) {
      try { await record(entry.callId, policy, 'deny', reason instanceof HarnessRuntimeError ? reason.code : 'DSH_SEARCH_FAILED'); }
      catch { throw fail('DSH_AUDIT_UNAVAILABLE', 'The research policy decision could not be persisted.'); }
      if (reason instanceof HarnessRuntimeError) throw new HarnessRuntimeError(reason.statusCode, reason.code, 'The controlled research search could not complete.', undefined, { retryable: reason.retryable });
      if (combined.aborted) throw fail('DSH_CANCELLED', 'The research search was cancelled.');
      throw fail('DSH_SEARCH_FAILED', 'The research search could not complete.', 502);
    }
  }
  return Object.freeze({ ceiling,
    execute(call) {
      let args;
      try { args = argumentsFor(call); } catch (reason) { return Promise.reject(reason); }
      const fingerprint = JSON.stringify(args), previous = calls.get(call.callId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return Promise.reject(fail('DSH_CALL_CONFLICT', 'This search call identity already belongs to different criteria.', 409));
        return previous.promise.then(async result => { await current(previous.version); return structuredClone(result); });
      }
      if (combined.aborted) return Promise.reject(fail('DSH_CANCELLED', 'The research search was cancelled.'));
      if (calls.size >= 32) return Promise.reject(fail('DSH_SEARCH_LIMIT', 'This Run has reached its search call identity limit.', 429));
      const entry = { callId: call.callId, args, fingerprint, version: undefined };
      entry.promise = pending.then(() => execute(entry)); pending = entry.promise.catch(() => {}); calls.set(entry.callId, entry);
      return entry.promise.then(result => structuredClone(result));
    },
    close() { controller.abort(); return pending; }
  });
}
