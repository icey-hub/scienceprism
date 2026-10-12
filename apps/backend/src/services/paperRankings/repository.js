import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';
import { withHubLock } from '../projectHub/repository.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { assertCompatibleCatalogs, normalizeRankingCatalog, PaperRankingError } from './validation.js';

const FILE = '.scienceprism/paper-rankings.json';
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CATALOGS = 64;
const MAX_TOTAL_RECORDS = 200000;
const catalogId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const contents = ({ scheme, editionYear, label, provenance, records }) => ({ scheme, editionYear, label, provenance, records });
const digest = catalog => createHash('sha256').update(JSON.stringify({ ...contents(catalog), records: catalog.records.map(record => JSON.stringify(record)).sort() })).digest('hex');

export function createPaperRankingRepository({ resolveProject = getProjectRoot } = {}) {
  async function rootFor(projectId) {
    try { return await resolveProject(projectId); }
    catch (error) { throw new PaperRankingError('RANKING_PROJECT_UNAVAILABLE', '项目不存在或不可读取。', error?.code === 'ENOENT' ? 404 : 400); }
  }
  function filePath(root, name) {
    try { return safeJoin(root, name); }
    catch { throw new PaperRankingError('RANKING_UNSAFE_PATH', '分级目录存储路径不安全。'); }
  }
  function validateStore(index, projectId) {
    if (index?.schemaVersion !== 1 || index.projectId !== projectId || !Number.isSafeInteger(index.version) || index.version < 0
      || !Array.isArray(index.catalogs) || index.catalogs.length > MAX_CATALOGS) throw new Error('Invalid ranking store');
    const ids = new Set(); let recordCount = 0;
    for (const catalog of index.catalogs) {
      if (!catalogId(catalog.id) || ids.has(catalog.id) || typeof catalog.importedAt !== 'string' || !Number.isFinite(Date.parse(catalog.importedAt))) throw new Error('Invalid catalog metadata');
      ids.add(catalog.id);
      const normalized = normalizeRankingCatalog({ ...contents(catalog), expectedVersion: 0 });
      if (JSON.stringify(contents(normalized)) !== JSON.stringify(contents(catalog)) || digest(catalog) !== catalog.sha256) throw new Error('Invalid catalog content');
      recordCount += catalog.records.length;
    }
    if (recordCount > MAX_TOTAL_RECORDS) throw new Error('Too many ranking records');
    for (const catalog of index.catalogs) {
      for (const key of ['supersededBy', 'replacesCatalogId']) if (catalog[key] && (!ids.has(catalog[key]) || catalog[key] === catalog.id)) throw new Error('Invalid replacement history');
    }
    assertCompatibleCatalogs(index.catalogs);
    return index;
  }
  async function readAtRoot(root, projectId) {
    let handle;
    try {
      handle = await fs.open(filePath(root, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new Error('Invalid storage size');
      return validateStore(JSON.parse(await handle.readFile('utf8')), projectId);
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, projectId, version: 0, catalogs: [] };
      if (error.code === 'RANKING_UNSAFE_PATH') throw error;
      throw new PaperRankingError('RANKING_STORAGE_INVALID', '分级目录无法读取或校验失败；原文件未修改。', 500);
    } finally { await handle?.close(); }
  }
  async function read(projectId) { return readAtRoot(await rootFor(projectId), projectId); }

  async function importCatalog(projectId, input) {
    const normalized = normalizeRankingCatalog(input);
    const content = contents(normalized); const sha256 = digest(content);
    return withHubLock(projectId, async () => {
      const root = await rootFor(projectId); const index = await readAtRoot(root, projectId);
      const duplicate = index.catalogs.find(catalog => !catalog.supersededBy && catalog.sha256 === sha256 && catalog.replacesCatalogId === normalized.replaceCatalogId);
      if (duplicate) return { version: index.version, catalog: duplicate, duplicate: true };
      if (normalized.expectedVersion !== index.version) throw new PaperRankingError('RANKING_VERSION_CONFLICT', `目录已更新为版本 ${index.version}，请刷新后重试。`, 409);
      const previous = normalized.replaceCatalogId ? index.catalogs.find(catalog => catalog.id === normalized.replaceCatalogId && !catalog.supersededBy) : null;
      if (normalized.replaceCatalogId && !previous) throw new PaperRankingError('RANKING_CATALOG_NOT_FOUND', '待替换的有效目录不存在。', 404);
      if (previous && (previous.scheme !== content.scheme || previous.editionYear !== content.editionYear)) throw new PaperRankingError('RANKING_INVALID_REPLACEMENT', '替换需保留相同分级体系和目录年份。');
      if (index.catalogs.length >= MAX_CATALOGS || index.catalogs.reduce((sum, catalog) => sum + catalog.records.length, content.records.length) > MAX_TOTAL_RECORDS) {
        throw new PaperRankingError('RANKING_STORAGE_LIMIT', '项目最多保留 64 个目录版本和 200000 条历史记录。', 413);
      }
      const catalog = { id: randomUUID(), ...content, sha256, importedAt: new Date().toISOString(), replacesCatalogId: previous?.id || null, supersededBy: null };
      assertCompatibleCatalogs([...index.catalogs.filter(item => item.id !== previous?.id), catalog]);
      if (previous) previous.supersededBy = catalog.id;
      index.catalogs.push(catalog); index.version++;
      const bytes = JSON.stringify(index, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > MAX_STORE_BYTES) throw new PaperRankingError('RANKING_STORAGE_LIMIT', '项目分级目录超过 64 MiB。', 413);
      await fs.mkdir(filePath(root, '.scienceprism'), { recursive: true });
      const temporary = filePath(root, `.scienceprism/.rankings-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, filePath(root, FILE));
      } finally { await fs.rm(temporary, { force: true }); }
      return { version: index.version, catalog: structuredClone(catalog), duplicate: false };
    });
  }
  return { read, importCatalog };
}
