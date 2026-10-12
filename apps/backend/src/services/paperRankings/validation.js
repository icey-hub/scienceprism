export const RANKING_SCHEMES = ['JCR', 'CAS', 'CCF', 'custom'];
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_CATALOG_RECORDS = 50000;

export class PaperRankingError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message); this.name = 'PaperRankingError'; this.code = code; this.statusCode = statusCode;
  }
}

const invalid = message => { throw new PaperRankingError('RANKING_INVALID_INPUT', message); };
export function text(value, label, limit = 300, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(`${label} 必须是有效文本。`);
  const result = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!result || result.length > limit) invalid(`${label} 长度需为 1–${limit} 字符。`);
  return result;
}

export const venueKey = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() : '';
export function normalizeIssn(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase().replace(/^ISSN\s+/, '').replace(/^(\d{4})-(\d{3}[\dX])$/, '$1$2');
  if (!/^\d{7}[\dX]$/.test(raw)) return null;
  const sum = [...raw].reduce((total, digit, index) => total + (digit === 'X' ? 10 : Number(digit)) * (8 - index), 0);
  return sum % 11 === 0 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

export function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} 必须是对象。`);
  if (Object.keys(value).some(key => !keys.includes(key))) invalid(`${label} 包含未知字段。`);
}

function rankValue(value, scheme) {
  const rank = text(typeof value === 'number' ? String(value) : value, '等级', 40);
  const normalized = scheme === 'custom' ? rank : rank.toUpperCase();
  const allowed = { JCR: ['Q1', 'Q2', 'Q3', 'Q4'], CAS: ['1', '2', '3', '4'], CCF: ['A', 'B', 'C'] };
  if (allowed[scheme] && !allowed[scheme].includes(normalized)) invalid(`${scheme} 等级无效。`);
  return normalized;
}

export function normalizeRankingCatalog(input) {
  object(input, '目录', ['expectedVersion', 'scheme', 'editionYear', 'label', 'provenance', 'records', 'replaceCatalogId']);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_IMPORT_BYTES) throw new PaperRankingError('RANKING_TOO_LARGE', '目录超过 16 MiB。', 413);
  if (!RANKING_SCHEMES.includes(input.scheme)) invalid('请选择 JCR、CAS、CCF 或 custom 目录。');
  if (!Number.isInteger(input.editionYear) || input.editionYear < 1800 || input.editionYear > 2100) invalid('目录年份需在 1800–2100 内。');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid('请提供当前目录版本 expectedVersion。');
  object(input.provenance, '目录来源', ['label', 'url', 'license']);
  const provenance = { label: text(input.provenance.label, '来源名称'), url: text(input.provenance.url, '来源 URL', 2048, true), license: text(input.provenance.license, '来源许可说明', 500, true) };
  if (provenance.url) {
    let url; try { url = new URL(provenance.url); } catch { invalid('来源 URL 无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('来源 URL 需为不含认证信息的 HTTP(S) 地址。');
  }
  if (!Array.isArray(input.records) || !input.records.length || input.records.length > MAX_CATALOG_RECORDS) invalid(`目录需包含 1–${MAX_CATALOG_RECORDS} 条记录。`);
  const seen = new Set();
  const records = input.records.map(record => {
    object(record, '分级记录', ['venue', 'issns', 'subject', 'rank']);
    const venue = text(record.venue, '发表载体', 300, true);
    if (record.issns !== undefined && (!Array.isArray(record.issns) || record.issns.length > 6)) invalid('ISSN 列表最多包含 6 项。');
    const issns = [...new Set((record.issns || []).map(value => { const issn = normalizeIssn(value); if (!issn) invalid('ISSN 格式或校验位无效。'); return issn; }))].sort();
    if (!venue && !issns.length) invalid('记录至少需要一个明确的发表载体名称或 ISSN。');
    return { venue, issns, subject: text(record.subject, '学科', 200), rank: rankValue(record.rank, input.scheme) };
  }).filter(record => { const key = JSON.stringify(record); if (seen.has(key)) return false; seen.add(key); return true; });
  return { scheme: input.scheme, editionYear: input.editionYear, label: text(input.label, '目录名称'), provenance, records,
    expectedVersion: input.expectedVersion, replaceCatalogId: text(input.replaceCatalogId, '被替换目录 ID', 80, true) || null };
}

export function normalizeRankingFilter(input = {}) {
  object(input, '分级筛选', ['scheme', 'editionYear', 'subject', 'ranks', 'unknown']);
  if (input.scheme !== undefined && input.scheme !== null && typeof input.scheme !== 'string') invalid('分级筛选体系无效。');
  const scheme = input.scheme || null;
  if (scheme && !RANKING_SCHEMES.includes(scheme)) invalid('分级筛选体系无效。');
  const editionYear = input.editionYear ?? null;
  if (editionYear !== null && (!Number.isInteger(editionYear) || editionYear < 1800 || editionYear > 2100)) invalid('分级筛选年份无效。');
  if (input.ranks !== undefined && (!Array.isArray(input.ranks) || input.ranks.length > 40)) invalid('分级筛选等级列表无效。');
  const ranks = [...new Set((input.ranks || []).map(rank => scheme ? rankValue(rank, scheme) : text(rank, '筛选等级', 40)))];
  if (ranks.length && !scheme) invalid('筛选等级前请选择分级体系。');
  const unknown = input.unknown ?? 'include';
  if (!['include', 'exclude', 'only'].includes(unknown)) invalid('未知等级规则需为 include、exclude 或 only。');
  return { scheme, editionYear, subject: text(input.subject, '筛选学科', 200, true) || null, ranks, unknown };
}

/** The same identity, scheme, edition and subject cannot silently acquire two ranks. */
export function assertCompatibleCatalogs(catalogs) {
  const byIssn = new Map(); const byVenue = new Map();
  const conflict = () => { throw new PaperRankingError('RANKING_CATALOG_CONFLICT', '同一体系、目录年、学科和发表载体存在不同等级；请检查来源或明确替换旧目录。', 409); };
  for (const catalog of catalogs.filter(item => !item.supersededBy)) for (const record of catalog.records) {
    const scope = JSON.stringify([catalog.scheme, catalog.editionYear, venueKey(record.subject)]);
    for (const issn of record.issns) {
      const key = `${scope}:${issn}`; const previous = byIssn.get(key);
      if (previous !== undefined && previous !== record.rank) conflict();
      byIssn.set(key, record.rank);
    }
    if (!record.venue) continue;
    const key = `${scope}:${venueKey(record.venue)}`;
    const previous = byVenue.get(key) || { ranks: new Set(), withoutIssns: new Set() };
    const relevant = record.issns.length ? previous.withoutIssns : previous.ranks;
    if ([...relevant].some(rank => rank !== record.rank)) conflict();
    previous.ranks.add(record.rank); if (!record.issns.length) previous.withoutIssns.add(record.rank);
    byVenue.set(key, previous);
  }
}

/** RFC-style quoted fields; ISSNs use semicolons within their column. Metadata is supplied separately. */
export function parseRankingCsv(csv) {
  if (typeof csv !== 'string' || !csv.isWellFormed()) invalid('CSV 必须是 UTF-8 文本。');
  if (Buffer.byteLength(csv) > MAX_IMPORT_BYTES) throw new PaperRankingError('RANKING_TOO_LARGE', 'CSV 超过 16 MiB。', 413);
  const source = csv.replace(/^\uFEFF/, ''); const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > 4) invalid('CSV 必须只有 venue、issns、subject、rank 四列。'); };
  const line = () => { cell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > MAX_CATALOG_RECORDS + 1) invalid('CSV 记录过多。'); };
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (quoted) {
      if (character === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (character === '"') { quoted = false; closed = true; }
      else field += character;
    } else if (character === ',') cell();
    else if (character === '\n' || character === '\r') { if (character === '\r' && source[i + 1] === '\n') i++; line(); }
    else if (character === '"' && !field && !closed) quoted = true;
    else if (closed || character === '"') invalid('CSV 引号或字段格式无效。');
    else field += character;
  }
  if (quoted) invalid('CSV 包含未闭合的引号。');
  if (field || row.length || closed) line();
  const header = rows.shift()?.map(value => value.trim());
  if (!header || header.length !== 4 || new Set(header).size !== 4 || header.some(value => !['venue', 'issns', 'subject', 'rank'].includes(value))) invalid('CSV 表头需为 venue、issns、subject、rank。');
  if (!rows.length) invalid('CSV 没有分级记录。');
  return rows.map(values => {
    if (values.length !== 4) invalid('CSV 每行必须包含四列。');
    const record = Object.fromEntries(header.map((key, index) => [key, values[index]]));
    record.issns = record.issns.split(';').map(value => value.trim()).filter(Boolean);
    return record;
  });
}
