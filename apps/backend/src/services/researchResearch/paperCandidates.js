import crypto from 'node:crypto';
import { normalizePaperCandidate } from './qualityGate.js';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function keyText(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/v\d+$/, '');
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return keyText(raw);
  }
}

export function paperIdentityKeys(input) {
  const paper = normalizePaperCandidate(input);
  const keys = [];
  if (paper.doi) keys.push(`doi:${keyText(paper.doi).replace(/^doi:/, '')}`);
  if (input?.arxivId) keys.push(`arxiv:${keyText(input.arxivId).replace(/^arxiv:/, '')}`);
  if (paper.url) keys.push(`url:${canonicalUrl(paper.url)}`);
  if (paper.title) {
    keys.push(`title:${keyText(paper.title)}`);
    keys.push(`title:${keyText(paper.title)}|year:${paper.year || ''}`);
  }
  return [...new Set(keys.filter((key) => key.length > 6))];
}

function sourceRecords(paper) {
  const records = Array.isArray(paper?.sourceRecords) ? paper.sourceRecords : [];
  const fallback = paper?.source ? [{ provider: paper.source, id: paper.id, retrievedAt: paper.retrievedAt || null }] : [];
  return [...records, ...fallback].filter((record, index, all) => {
    const identity = `${record.provider || ''}:${record.id || ''}:${record.url || ''}`;
    return all.findIndex((item) => `${item.provider || ''}:${item.id || ''}:${item.url || ''}` === identity) === index;
  });
}

function chooseValue(left, right, key) {
  const leftValue = left?.[key];
  const rightValue = right?.[key];
  if (Array.isArray(leftValue) && Array.isArray(rightValue)) return [...new Set([...leftValue, ...rightValue].filter(Boolean))];
  if (leftValue === null || leftValue === undefined || leftValue === '') return rightValue ?? leftValue;
  if (rightValue === null || rightValue === undefined || rightValue === '') return leftValue;
  return leftValue;
}

/** Merge provider records while preserving provenance and the richest metadata. */
export function mergePaperCandidates(records = []) {
  const groups = new Map();
  const keyToGroup = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizePaperCandidate(record);
    const keys = paperIdentityKeys(normalized);
    const groupId = keys.map((key) => keyToGroup.get(key)).find(Boolean) || `paper-${crypto.createHash('sha1').update(keys[0] || JSON.stringify(normalized)).digest('hex').slice(0, 16)}`;
    const current = groups.get(groupId);
    if (!current) {
      groups.set(groupId, { ...normalized, sourceRecords: sourceRecords(normalized), identityKeys: keys });
    } else {
      const merged = { ...current };
      for (const key of ['id', 'title', 'abstract', 'authors', 'year', 'venue', 'venueLevel', 'peerReviewed', 'publicationType', 'citationCount', 'hasCode', 'doi', 'url', 'codeUrl', 'source', 'links', 'metadataUpdatedAt']) merged[key] = chooseValue(current, normalized, key);
      merged.sourceRecords = sourceRecords({ ...merged, sourceRecords: [...sourceRecords(current), ...sourceRecords(normalized)] });
      merged.identityKeys = [...new Set([...current.identityKeys, ...keys])];
      groups.set(groupId, merged);
    }
    for (const key of keys) keyToGroup.set(key, groupId);
  }
  return [...groups.values()].map((paper) => ({ ...paper, sourceCount: paper.sourceRecords.length }));
}

export function validatePaperMetadata(input) {
  const paper = normalizePaperCandidate(input);
  const required = ['title', 'authors', 'year', 'abstract', 'url'];
  const missing = required.filter((field) => {
    const value = paper[field];
    return Array.isArray(value) ? value.length === 0 : value === null || value === undefined || value === '';
  });
  return {
    ok: missing.length === 0,
    missing,
    verifiedFields: required.filter((field) => !missing.includes(field)),
    sourceCount: Array.isArray(input?.sourceRecords) ? input.sourceRecords.length : (input?.source ? 1 : 0),
    warnings: missing.length ? ['Metadata is incomplete and requires human verification.'] : []
  };
}

export function prioritizePaperCandidates(records = [], { sourcePriorities = {} } = {}) {
  return [...records].sort((left, right) => {
    const leftPriority = Number(sourcePriorities[left.source] ?? 0) + Number(left.sourceCount || 0);
    const rightPriority = Number(sourcePriorities[right.source] ?? 0) + Number(right.sourceCount || 0);
    return rightPriority - leftPriority || String(left.title || '').localeCompare(String(right.title || ''));
  });
}
