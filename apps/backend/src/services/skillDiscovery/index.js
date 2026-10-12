import { getProjectRoot } from '../projectService.js';
import { listSkillCatalog, RESEARCH_SKILL_STAGES } from '../skillCatalog.js';
import { createGithubSkillSource, normalizeRepository, SkillDiscoveryError, invalid, abortable } from './github.js';
import { inspectSkillCandidate, discoveryTerms, matchResearchPurpose } from './metadata.js';

export const SKILL_DISCOVERY_CATALOGS = Object.freeze([
  Object.freeze({ id: 'openai-plugins', label: 'OpenAI Plugins', repository: 'openai/plugins', path: 'plugins', url: 'https://github.com/openai/plugins',
    description: '发布者维护的示例目录；部分 Skill 依赖伴随插件或 MCP，需单独核对。' }),
  Object.freeze({ id: 'anthropic-skills', label: 'Anthropic Skills', repository: 'anthropics/skills', path: 'skills', url: 'https://github.com/anthropics/skills',
    description: '发布者维护的 Skill 示例；许可逐项读取，不能假定全部允许相同使用方式。' })
]);
const FILTERS = { license: ['any', 'document-found', 'unknown'], metadata: ['any', 'declared', 'unknown'], scripts: ['any', 'present', 'absent'], installed: ['hide', 'any', 'only'] };
export function normalizeDiscoveryInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['repositories', 'query', 'stage', 'limit', 'offset', 'filters'].includes(key))) throw invalid('Skill 发现参数无效。');
  const query = input.query ?? ''; const stage = input.stage ?? null; const limit = input.limit ?? 6; const offset = input.offset ?? 0;
  if (typeof query !== 'string' || query.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(query)) throw invalid('研究任务关键词最多 500 字符。');
  if (stage !== null && !RESEARCH_SKILL_STAGES.includes(stage)) throw invalid('研究阶段无效。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 6 || !Number.isInteger(offset) || offset < 0 || offset > 30_000) throw invalid('每次读取 1–6 个 Skill；分页 offset 无效。');
  const repositories = input.repositories ?? [{ repository: SKILL_DISCOVERY_CATALOGS[0].repository, path: SKILL_DISCOVERY_CATALOGS[0].path }];
  if (!Array.isArray(repositories) || !repositories.length || repositories.length > 2) throw invalid('每次最多读取两个 GitHub 仓库范围。');
  const unique = new Map(repositories.map(source => { const normalized = normalizeRepository(source); return [JSON.stringify(normalized), normalized]; }));
  const filters = input.filters ?? {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !FILTERS[key])) throw invalid('Skill 筛选条件无效。');
  const normalizedFilters = {};
  for (const [key, choices] of Object.entries(FILTERS)) {
    const value = filters[key] ?? choices[0]; if (!choices.includes(value)) throw invalid('Skill 筛选条件无效。'); normalizedFilters[key] = value;
  }
  return { repositories: [...unique.values()], query: query.trim(), stage, limit, offset, filters: normalizedFilters };
}

export function filterSkillCandidates(candidates, filters) {
  return candidates.filter(candidate => {
    if (filters.license === 'document-found' && candidate.license.status !== 'document-found') return false;
    if (filters.license === 'unknown' && candidate.license.status === 'document-found') return false;
    if (filters.metadata !== 'any' && candidate.metadataStatus !== filters.metadata) return false;
    if (filters.scripts === 'present' && candidate.scripts.total === 0) return false;
    if (filters.scripts === 'absent' && candidate.scripts.total !== 0) return false;
    if (filters.installed === 'hide' && candidate.installedMatch !== null) return false;
    if (filters.installed === 'only' && candidate.installedMatch === null) return false;
    return true;
  });
}
const fatal = error => ['SKILL_DISCOVERY_CANCELLED', 'SKILL_DISCOVERY_TIMEOUT', 'SKILL_DISCOVERY_REQUEST_LIMIT',
  'SKILL_DISCOVERY_AUTH_INVALID', 'SKILL_DISCOVERY_AUTH_CONFIGURATION', 'SKILL_DISCOVERY_RATE_LIMITED',
  'CAPABILITY_DENIED', 'NETWORK_DENIED'].includes(error.code);
const errorData = error => ({ code: error.code || 'SKILL_DISCOVERY_UPSTREAM', message: error.statusCode ? error.message : 'Skill 目录读取失败。' });

export function createSkillDiscoveryService({ sourceFactory = createGithubSkillSource(), resolveProject = getProjectRoot,
  listInstalled = listSkillCatalog, timeoutMs = 30_000 } = {}) {
  return {
    async catalogs(projectId) {
      await resolveProject(projectId);
      return { catalogs: SKILL_DISCOVERY_CATALOGS, limits: { repositories: 2, skillsPerPage: 6, documentBytes: 128_000, requests: 32 },
        discoveryOnly: true, contentTrusted: false };
    },
    async discover(projectId, input = {}, { signal, capabilityPolicy } = {}) {
      const request = normalizeDiscoveryInput(input);
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
      try {
        return await abortable(async () => {
          const projectRoot = await resolveProject(projectId);
          const installed = await listInstalled({ projectId, projectRoot, capabilityPolicy });
          if (combined.aborted) return abortable(() => {}, combined);
          const session = sourceFactory({ signal: combined, capabilityPolicy });
          const snapshots = []; const errors = []; let firstError;
          for (const repository of request.repositories) {
            try { snapshots.push(await session.resolve(repository)); }
            catch (error) {
              if (fatal(error)) throw error;
              firstError ??= error; errors.push({ repository: repository.repository, ...errorData(error) });
            }
          }
          if (!snapshots.length) throw firstError || new SkillDiscoveryError('SKILL_DISCOVERY_UPSTREAM', '无法读取目录。', 502);
          const terms = discoveryTerms(request.query, request.stage);
          const files = new Map();
          for (const snapshot of snapshots) for (const file of snapshot.files) {
            if ((file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')) && (!snapshot.path || file.path.startsWith(`${snapshot.path}/`))) {
              const key = `${snapshot.repository}@${snapshot.commit}:${file.path}`;
              if (!files.has(key)) files.set(key, { snapshot, path: file.path, priority: terms.filter(term => file.path.toLowerCase().includes(term)).length });
            }
          }
          const ordered = [...files.values()].sort((a, b) => b.priority - a.priority || a.snapshot.repository.localeCompare(b.snapshot.repository) || a.path.localeCompare(b.path));
          const selected = ordered.slice(request.offset, request.offset + request.limit);
          const candidates = [];
          for (const entry of selected) {
            try {
              const candidate = await inspectSkillCandidate(entry.snapshot, entry.path);
              const match = (installed.skills || []).find(skill => skill.name === candidate.name);
              candidate.installedMatch = match ? { kind: 'name-collision', identityVerified: false, name: match.name, source: match.source, available: match.available } : null;
              candidate.researchMatch = matchResearchPurpose(candidate, request.query, request.stage);
              candidate.source.catalogId = SKILL_DISCOVERY_CATALOGS.find(catalog => catalog.repository === candidate.source.repository)?.id || null;
              candidates.push(candidate);
            } catch (error) {
              if (fatal(error)) throw error;
              errors.push({ repository: entry.snapshot.repository, path: entry.path, ...errorData(error) });
            }
          }
          candidates.sort((a, b) => b.researchMatch.score - a.researchMatch.score || a.id.localeCompare(b.id));
          const result = filterSkillCandidates(candidates, request.filters);
          return { query: request.query, stage: request.stage, filters: request.filters, candidates: result,
            excludedInstalled: request.filters.installed === 'hide' ? candidates.filter(candidate => candidate.installedMatch).map(candidate => ({ id: candidate.id, name: candidate.name, source: candidate.source, installedMatch: candidate.installedMatch })) : [],
            sources: snapshots.map(snapshot => ({ repository: snapshot.repository, requestedRef: snapshot.ref, commit: snapshot.commit, path: snapshot.path, url: snapshot.url, skippedLinks: snapshot.skippedLinks })),
            scope: { mode: 'bounded-repository-scan', totalSkillFiles: ordered.length, offset: request.offset, attempted: selected.length, inspected: candidates.length,
              returned: result.length, nextOffset: request.offset + selected.length < ordered.length ? request.offset + selected.length : null,
              requestCount: session.requestCount, filtersApplyToInspectedPage: true, pathKeywordsPrioritized: terms.length > 0 },
            status: errors.length ? 'partial' : 'complete', errors, discoveryOnly: true, recommendationMethod: 'deterministic-keywords',
            runtimeVerified: false, installationPerformed: false };
        }, combined);
      } finally { clearTimeout(timer); controller.abort(); }
    }
  };
}
const defaultService = createSkillDiscoveryService();
export const discoverProjectSkills = (projectId, input, options) => defaultService.discover(projectId, input, options);
