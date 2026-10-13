import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshResearchBroker } from '../src/services/harnessRuntime/dshResearchBroker.js';
import { HarnessRuntimeError } from '../src/services/harnessRuntime/errors.js';

const input = { query: 'graph learning', sources: ['arxiv', 'openalex'], filters: { yearFrom: 2020, openAccessOnly: true }, ranking: { scheme: 'CCF', ranks: ['A'], unknown: 'include' } };
const call = (callId = 'search-1', args = input) => ({ tool: 'research_search_papers', callId, arguments: args });
const endpoint = source => source === 'arxiv' ? 'https://export.arxiv.org/api/query?search_query=all:graph' : 'https://api.openalex.org/works?search=graph';
function session(criteria, projectId = 'project', overrides = {}) {
  return { id: 'session-saved', projectId, createdAt: '2026-10-13T00:00:00.000Z', criteria, status: 'completed', nextOffset: null,
    candidates: [{ id: 'paper', title: 'Graph Learning', source: 'arxiv', year: 2023, venue: 'Example', rankingStatus: 'known',
      searchSessionIds: ['session-saved'], sourceRecords: [{ provider: 'arxiv', id: '1234', retrievedAt: '2026-10-13T00:00:00.000Z', searchSessionId: 'session-saved' }],
      rankings: [{ scheme: 'CCF', rank: 'A', editionYear: 2023, subject: 'AI', catalogId: 'catalog', provenance: { label: 'catalog source', url: 'https://example.org/catalog' } }] }],
    failures: [], sourceResults: [{ source: 'arxiv', received: 1, matched: 1, total: 100, filterMode: 'batch' }, { source: 'openalex', received: 0, matched: 0, total: 200, filterMode: 'server' }],
    rankingCoverage: { catalogVersion: 1, catalogCount: 1, total: 1, matched: 1, unmatched: 0, returned: 1, ratio: 1 }, ...overrides };
}
async function fixture(t, options = {}) {
  let policy = { projectId: 'project', runId: 'run', role: 'researcher', task: 'search', version: 'v1', active: true, mode: 'auto',
    capabilities: { granted: ['research.search'], allowedPaths: [], networkAllowlist: ['export.arxiv.org', 'api.openalex.org'] }, ...options.initialPolicy };
  const decisions = [], events = [], searches = [], effects = [];
  let search = options.search || (async (projectId, criteria, hooks) => {
    for (const source of criteria.sources) { await hooks.beforeRequest({ source, url: endpoint(source) }); effects.push({ type: 'request', source }); }
    await hooks.beforePersist(); effects.push({ type: 'persist', projectId }); return session(criteria, projectId);
  });
  const broker = await createDshResearchBroker({ readPolicy: async () => structuredClone(policy), onDecision: async decision => {
    decisions.push(decision); await options.onDecision?.(decision);
  }, signal: options.signal, search: async (...args) => { searches.push(args); return search(...args); }, emit: event => events.push(event) });
  t.after(() => broker.close());
  return { broker, decisions, events, searches, effects, policy: () => structuredClone(policy), setPolicy: patch => { policy = { ...policy, ...patch }; },
    setSearch: value => { search = value; } };
}

test('bound search uses transport/persistence hooks and returns the same saved session with ranking provenance', async t => {
  const f = await fixture(t); const result = await f.broker.execute(call());
  assert.equal(f.searches.length, 1); assert.equal(f.searches[0][0], 'project'); assert.equal(result.id, 'session-saved');
  assert.equal(result.candidates[0].sourceRecords[0].searchSessionId, result.id);
  assert.equal(result.candidates[0].rankings[0].rank, 'A'); assert.equal(result.rankingCoverage.catalogVersion, 1);
  assert.equal(result.criteria.filters.yearFrom, 2020); assert.deepEqual(result.criteria.ranking.ranks, ['A']);
  assert.equal(f.effects.length, 3); assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'research/search');
  assert.equal(f.events[0].data.searchSessionId, result.id); assert.equal(f.events[0].data.evidenceConfirmed, false);
  assert.equal(f.decisions[0].actor, 'system'); assert.equal(f.decisions[0].decision, 'allow');
});

test('unknown fields, arbitrary sources and invalid criteria never invoke search', async t => {
  const f = await fixture(t);
  for (const args of [{ ...input, projectId: 'other' }, { ...input, url: 'http://localhost' }, { ...input, provider: 'custom' },
    { ...input, sources: ['crossref'] }, { ...input, filters: { secret: true } }, { ...input, ranking: { url: 'https://example.org' } },
    { ...input, pageSize: 41 }, { ...input, query: 'x\0y' }, { ...input, query: 'x'.repeat(1001) },
    { ...input, ranking: null }, { ...input, filters: { publicationType: false } }]) {
    await assert.rejects(f.broker.execute(call('invalid', args)), error => error.code === 'DSH_ARGUMENTS_INVALID');
  }
  await assert.rejects(f.broker.execute({ ...call(), tool: 'fetch_url' }), error => error.code === 'DSH_ARGUMENTS_INVALID');
  assert.equal(f.searches.length, 0);
});

test('changed owning identities, inactive/manual states and revoked permission are denied', async t => {
  for (const patch of [{ projectId: 'other' }, { runId: 'other' }, { role: 'other' }, { task: 'other' }, { active: false }, { mode: 'manual' },
    { capabilities: { granted: [], allowedPaths: [], networkAllowlist: ['export.arxiv.org'] } }]) {
    const f = await fixture(t); f.setPolicy(patch);
    await assert.rejects(f.broker.execute(call()), error => ['DSH_OWNER_CHANGED', 'DSH_RUN_INACTIVE', 'DSH_APPROVAL_UNAVAILABLE', 'CAPABILITY_DENIED'].includes(error.code));
    assert.equal(f.searches.length, 0); assert.equal(f.decisions.at(-1).decision, 'deny');
  }
});

test('audit failure and revocation/version changes while recording allow stop before network effects', async t => {
  const broken = await fixture(t, { onDecision: async () => { throw new Error('audit password=hidden'); } });
  await assert.rejects(broken.broker.execute(call()), error => error.code === 'DSH_AUDIT_UNAVAILABLE' && !error.message.includes('hidden'));
  assert.equal(broken.searches.length, 0);
  const allowOnly = await fixture(t, { onDecision: async decision => { if (decision.decision === 'allow') throw new Error('first audit unavailable'); } });
  await assert.rejects(allowOnly.broker.execute(call()), error => error.code === 'DSH_AUDIT_UNAVAILABLE'); assert.equal(allowOnly.searches.length, 0);
  for (const mutation of ['permission', 'version']) {
    let f;
    f = await fixture(t, { onDecision: async decision => { if (decision.decision === 'allow') f.setPolicy(mutation === 'version' ? { version: 'v2' }
      : { capabilities: { granted: [], allowedPaths: [], networkAllowlist: [] } }); } });
    await assert.rejects(f.broker.execute(call()), error => ['DSH_POLICY_CHANGED', 'CAPABILITY_DENIED'].includes(error.code));
    assert.equal(f.searches.length, 0); assert.equal(f.effects.length, 0);
  }
});

test('network hooks enforce fixed HTTPS source hosts/paths and both network scopes', async t => {
  for (const request of [{ source: 'arxiv', url: 'http://export.arxiv.org/api/query' }, { source: 'arxiv', url: 'https://export.arxiv.org/pdf/a' },
    { source: 'openalex', url: 'https://api.openalex.org.evil.test/works' }, { source: 'openalex', url: 'https://user:password@api.openalex.org/works' },
    { source: 'openalex', url: 'https://api.openalex.org:8443/works' }, { source: 'openalex', url: 'https://api.openalex.org/works#bad' },
    { source: 'custom', url: 'https://api.openalex.org/works' }]) {
    const f = await fixture(t, { search: async (_project, _criteria, hooks) => { await hooks.beforeRequest(request); assert.fail('must not fetch'); } });
    await assert.rejects(f.broker.execute(call()), error => error.code === 'NETWORK_DENIED');
  }
  const f = await fixture(t); const policy = f.policy(); f.setPolicy({ capabilities: { ...policy.capabilities, networkAllowlist: ['export.arxiv.org'] } });
  await assert.rejects(f.broker.execute(call()), error => error.code === 'NETWORK_DENIED');
  assert.deepEqual(f.effects, [{ type: 'request', source: 'arxiv' }]);
  const unselected = await fixture(t, { search: async (_project, _criteria, hooks) => { await hooks.beforeRequest({ source: 'openalex', url: endpoint('openalex') }); } });
  await assert.rejects(unselected.broker.execute(call('one', { query: 'graph', sources: ['arxiv'] })), error => error.code === 'NETWORK_DENIED');
});

test('revocation at each real-effect hook prevents request or persistence after policy drift', async t => {
  for (const stage of ['request', 'persist']) {
    const f = await fixture(t); const effects = [];
    f.setSearch(async (projectId, criteria, hooks) => {
      if (stage === 'request') f.setPolicy({ version: 'v2' });
      await hooks.beforeRequest({ source: 'arxiv', url: endpoint('arxiv') }); effects.push('request');
      if (stage === 'persist') f.setPolicy({ version: 'v2' });
      await hooks.beforePersist(); effects.push('persist'); return session(criteria, projectId);
    });
    await assert.rejects(f.broker.execute(call()), error => error.code === 'DSH_POLICY_CHANGED');
    assert.deepEqual(effects, stage === 'request' ? [] : ['request']); assert.equal(f.events.length, 0);
  }
});

test('same normalized call uses one search promise and changed input conflicts without new work', async t => {
  const f = await fixture(t); let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  f.setSearch(async (projectId, criteria, hooks) => { await gate; await hooks.beforePersist(); return session(criteria, projectId); });
  const first = f.broker.execute(call()); const repeated = f.broker.execute(call('search-1', { ranking: input.ranking, filters: input.filters, sources: input.sources, query: ' graph learning ' }));
  await assert.rejects(f.broker.execute(call('search-1', { ...input, query: 'different' })), error => error.code === 'DSH_CALL_CONFLICT');
  unblock(); assert.deepEqual(await first, await repeated); assert.equal(f.searches.length, 1); assert.equal(f.events.length, 1);
  const copy = await f.broker.execute(call()); copy.criteria.query = 'mutated';
  assert.equal((await f.broker.execute(call())).criteria.query, 'graph learning');
  f.setPolicy({ version: 'v2' }); await assert.rejects(f.broker.execute(call()), error => error.code === 'DSH_POLICY_CHANGED');
  assert.equal(f.searches.length, 1);
});

test('search call identities remain bounded at 32 and are not silently evicted', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 32; index++) await f.broker.execute(call(`call-${index}`));
  await assert.rejects(f.broker.execute(call('call-33')), error => error.code === 'DSH_SEARCH_LIMIT');
  assert.equal((await f.broker.execute(call('call-0'))).id, 'session-saved'); assert.equal(f.searches.length, 32);
});

test('close aborts and drains the in-flight search, denies queued work, and prevents late completion', async t => {
  const f = await fixture(t); let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.setSearch(async (_project, _criteria, hooks) => { started(); await new Promise((resolve, reject) => hooks.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  const first = f.broker.execute(call('first')); const firstRejected = assert.rejects(first, error => error.code === 'DSH_CANCELLED');
  const queued = f.broker.execute(call('second')); const queuedRejected = assert.rejects(queued, error => error.code === 'DSH_CANCELLED');
  await ready; await f.broker.close(); await firstRejected; await queuedRejected;
  assert.equal(f.searches.length, 1); assert.equal(f.events.length, 0);
  await assert.rejects(f.broker.execute(call('third')), error => error.code === 'DSH_CANCELLED');
});

test('external cancellation and late policy changes cannot return a completed search result', async t => {
  const controller = new AbortController(); const f = await fixture(t, { signal: controller.signal });
  f.setSearch(async (projectId, criteria) => { controller.abort(); return session(criteria, projectId); });
  await assert.rejects(f.broker.execute(call()), error => error.code === 'DSH_CANCELLED'); assert.equal(f.events.length, 0);
});

test('source partial failures retain semantics while arbitrary errors and typed error messages are sanitized', async t => {
  const f = await fixture(t, { search: async (projectId, criteria, hooks) => { await hooks.beforePersist(); return session(criteria, projectId, { status: 'partial', failures: [{ source: 'openalex', code: 'SOURCE_RATE_LIMITED', message: 'Bearer secret-token', retryable: true }] }); } });
  const result = await f.broker.execute(call()); assert.equal(result.status, 'partial'); assert.equal(result.failures[0].code, 'SOURCE_RATE_LIMITED');
  assert.equal(result.failures[0].retryable, true); assert.equal(JSON.stringify(result).includes('secret-token'), false);
  for (const error of [new Error('key=never-return'), new HarnessRuntimeError(429, 'PROVIDER_LIMIT', 'Bearer never-return')]) {
    const failed = await fixture(t, { search: async () => { throw error; } });
    await assert.rejects(failed.broker.execute(call()), reason => reason instanceof HarnessRuntimeError && !reason.message.includes('never-return')
      && reason.code === (error instanceof HarnessRuntimeError ? 'PROVIDER_LIMIT' : 'DSH_SEARCH_FAILED'));
  }
});

test('large saved results return bounded summaries without losing the session and complete filter criteria', async t => {
  const f = await fixture(t, { search: async (projectId, criteria, hooks) => { await hooks.beforePersist(); return session(criteria, projectId, {
    candidates: Array.from({ length: 80 }, (_, index) => ({ id: `paper-${index}`, title: '论'.repeat(10000), abstract: '😀'.repeat(60000),
      authors: Array(100).fill('Author'.repeat(100)), url: 'https://example.org/' + 'a'.repeat(10000), sourceRecords: Array(50).fill({ provider: 'arxiv', id: 'b'.repeat(10000) }) })) }); } });
  const result = await f.broker.execute(call()); assert.equal(result.id, 'session-saved'); assert.equal(result.candidateCount, 80);
  assert.equal(result.candidates.length, 40); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 512 * 1024);
  assert.deepEqual(result.criteria.ranking.ranks, ['A']); assert.equal(result.criteria.filters.openAccessOnly, true);
  assert.ok(result.candidates.every(candidate => candidate.title.isWellFormed() && candidate.abstract.isWellFormed()));
});

test('current expansion cannot exceed the initial capability and network ceiling', async t => {
  const f = await fixture(t, { initialPolicy: { capabilities: { granted: ['research.search'], allowedPaths: [], networkAllowlist: ['export.arxiv.org'] } } });
  f.setPolicy({ capabilities: { granted: ['research.search'], allowedPaths: [], networkAllowlist: ['export.arxiv.org', 'api.openalex.org'] } });
  await assert.rejects(f.broker.execute(call()), error => error.code === 'NETWORK_DENIED');
  const denied = await fixture(t, { initialPolicy: { capabilities: { granted: [], allowedPaths: [], networkAllowlist: ['export.arxiv.org'] } } });
  denied.setPolicy({ capabilities: { granted: ['research.search'], allowedPaths: [], networkAllowlist: ['export.arxiv.org'] } });
  await assert.rejects(denied.broker.execute(call('one', { query: 'graph' })), error => error.code === 'CAPABILITY_DENIED');
  assert.equal(denied.searches.length, 0);
});

test('result ownership and saved criteria must match before any completion is emitted', async t => {
  for (const mutation of ['project', 'criteria']) {
    const f = await fixture(t, { search: async (projectId, criteria, hooks) => { await hooks.beforePersist();
      return session(mutation === 'criteria' ? { ...criteria, query: 'different' } : criteria, mutation === 'project' ? 'other' : projectId); } });
    await assert.rejects(f.broker.execute(call()), error => error.code === 'DSH_SEARCH_RESULT_INVALID'); assert.equal(f.events.length, 0);
  }
});
