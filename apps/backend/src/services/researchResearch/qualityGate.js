/**
 * Deterministic paper-quality gate.
 *
 * This module deliberately has no I/O and never asks an LLM to make a hard
 * eligibility decision. Metadata that cannot be verified is represented as
 * null and handled by the configured unknownMetadata policy.
 */

export const PAPER_DECISIONS = Object.freeze({
  ACCEPT: 'accept',
  REJECT: 'reject',
  NEEDS_REVIEW: 'needs-review'
});

export const CHECK_STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  UNKNOWN: 'unknown'
});

export const DEFAULT_QUALITY_POLICY = Object.freeze({
  requiredVenueLevels: [],
  allowedVenues: [],
  allowedPublicationTypes: [],
  minYear: null,
  maxYear: null,
  peerReviewedOnly: false,
  requireCode: false,
  unknownMetadata: PAPER_DECISIONS.NEEDS_REVIEW,
  venueCatalog: {},
  scoreWeights: {}
});

const YEAR_MIN = 1000;
const YEAR_MAX = 9999;

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeKey(value) {
  return asText(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[&]/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeAuthors(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === 'string'
      ? value.split(/\s*;\s*|\s+and\s+/i)
      : (value && typeof value === 'object' ? [value] : []));
  return unique(values.map((author) => {
    if (typeof author === 'string') return asText(author);
    return asText(author?.name || author?.fullName || author?.authorName);
  }));
}

function normalizeYear(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= YEAR_MIN && value <= YEAR_MAX) {
    return value;
  }
  const match = asText(value).match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const normalized = asText(value).toLowerCase();
  if (['true', 'yes', 'y', '1', 'peer-reviewed', 'peer reviewed'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'not peer-reviewed', 'non-peer-reviewed'].includes(normalized)) return false;
  return null;
}

function normalizeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Normalize CCF values while avoiding assumptions about an unknown venue. */
export function normalizeVenueLevel(value) {
  if (value && typeof value === 'object') {
    return normalizeVenueLevel(value.level || value.ccfLevel || value.rank || value.category);
  }
  const normalized = asText(value).toUpperCase().replace(/[\s_]+/g, '-');
  if (/^(?:CCF-?)?A$/.test(normalized)) return 'CCF-A';
  if (/^(?:CCF-?)?B$/.test(normalized)) return 'CCF-B';
  if (/^(?:CCF-?)?C$/.test(normalized)) return 'CCF-C';
  return null;
}

function normalizeVenue(value) {
  if (value && typeof value === 'object') {
    return asText(value.name || value.title || value.displayName || value.venue);
  }
  return asText(value);
}

function normalizePublicationType(value) {
  const valueText = asText(value).toLowerCase();
  if (!valueText) return null;
  if (valueText.includes('journal')) return 'journal';
  if (valueText.includes('conference') || valueText.includes('proceedings')) return 'conference';
  if (valueText.includes('workshop')) return 'workshop';
  if (valueText.includes('preprint') || valueText.includes('arxiv')) return 'preprint';
  return valueText;
}

function normalizePublicationTypes(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return unique(values.map(normalizePublicationType));
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.map((link) => {
    if (typeof link === 'string') return asText(link);
    return asText(link?.url || link?.href);
  }));
}

/**
 * Convert common OpenAlex, Semantic Scholar, Crossref, arXiv and local search
 * shapes into one stable candidate shape. Missing evidence remains null.
 */
export function normalizePaperCandidate(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const links = normalizeLinks(firstValue(source.links, source.urls));
  const url = asText(firstValue(source.url, source.landingPage, source.idUrl)) || links[0] || null;
  const codeUrl = asText(firstValue(
    source.codeUrl,
    source.repositoryUrl,
    source.codeRepository,
    source.repository
  )) || null;
  const doi = asText(firstValue(source.doi, source.DOI)) || null;
  const venue = normalizeVenue(firstValue(
    source.venue,
    source.journal,
    source.conference,
    source.containerTitle,
    source.publicationVenue,
    source.hostVenue
  ));
  const rawVenueLevel = firstValue(
    source.venueLevel,
    source.ccfLevel,
    source.ccf,
    source.rank,
    source.qualityRank
  );
  const hasCodeValue = firstValue(source.hasCode, source.codeAvailable, codeUrl ? true : undefined);

  return {
    id: asText(firstValue(source.id, source.paperId, source.paper_id, source.arxivId, doi, url)) || null,
    title: asText(firstValue(source.title, source.name)) || null,
    abstract: asText(firstValue(source.abstract, source.summary, source.description)) || null,
    authors: normalizeAuthors(firstValue(source.authors, source.authorList, source.author)),
    year: normalizeYear(firstValue(source.year, source.publicationYear, source.published, source.date)),
    venue: venue || null,
    venueLevel: normalizeVenueLevel(rawVenueLevel),
    peerReviewed: normalizeBoolean(firstValue(source.peerReviewed, source.isPeerReviewed, source.peer_reviewed)),
    publicationType: normalizePublicationType(firstValue(source.publicationType, source.type)),
    citationCount: normalizeNumber(firstValue(source.citationCount, source.citations, source.citedByCount)),
    hasCode: normalizeBoolean(hasCodeValue),
    doi,
    url,
    codeUrl,
    source: asText(firstValue(source.source, source.provider, source.database)) || null,
    links,
    metadataUpdatedAt: asText(firstValue(source.metadataUpdatedAt, source.updatedAt)) || null,
    retrievedAt: asText(firstValue(source.retrievedAt, source.acquiredAt)) || null,
    sourceRecords: Array.isArray(source.sourceRecords) ? source.sourceRecords : [],
    sourceCount: Number(source.sourceCount) || (source.source ? 1 : 0)
  };
}

export const standardizePaperCandidate = normalizePaperCandidate;
export const normalizePaper = normalizePaperCandidate;

export function normalizePaperCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).map(normalizePaperCandidate);
}

export const standardizePaperCandidates = normalizePaperCandidates;

function normalizeVenueList(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return unique(values.map(normalizeVenue));
}

function normalizeLevelList(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return unique(values.map(normalizeVenueLevel));
}

function normalizeBound(value) {
  const year = normalizeYear(value);
  return year === null ? null : year;
}

function normalizeUnknownPolicy(value) {
  const normalized = asText(value).toLowerCase().replace(/_/g, '-');
  return ['reject', 'fail-closed'].includes(normalized)
    ? PAPER_DECISIONS.REJECT
    : PAPER_DECISIONS.NEEDS_REVIEW;
}

function normalizeVenueCatalog(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value)
    .map(([venue, level]) => [normalizeKey(venue), normalizeVenueLevel(level)])
    .filter(([, level]) => level));
}

/** Normalize policy aliases once at the quality-gate boundary. */
export function normalizeQualityPolicy(policy = {}) {
  const source = policy && typeof policy === 'object' ? policy : {};
  const yearRange = Array.isArray(source.yearRange) ? source.yearRange : [];
  const minYear = normalizeBound(firstValue(source.minYear, source.fromYear, yearRange[0]));
  const maxYear = normalizeBound(firstValue(source.maxYear, source.toYear, yearRange[1]));
  return {
    requiredVenueLevels: normalizeLevelList(firstValue(
      source.requiredVenueLevels,
      source.venueLevels,
      source.ccfLevels,
      source.ccf,
      source.ccfLevel
    )),
    allowedVenues: normalizeVenueList(firstValue(
      source.allowedVenues,
      source.requiredVenues,
      source.venues,
      source.venue
    )),
    allowedPublicationTypes: normalizePublicationTypes(firstValue(
      source.allowedPublicationTypes,
      source.publicationTypes,
      source.types,
      source.publicationType
    )),
    minYear,
    maxYear,
    peerReviewedOnly: normalizeBoolean(source.peerReviewedOnly) === true,
    requireCode: normalizeBoolean(firstValue(source.requireCode, source.codeRequired, source.requirePublicCode)) === true,
    unknownMetadata: normalizeUnknownPolicy(firstValue(source.unknownMetadata, source.unknownPolicy)),
    venueCatalog: normalizeVenueCatalog(firstValue(source.venueCatalog, source.venueRegistry)),
    scoreWeights: source.scoreWeights && typeof source.scoreWeights === 'object' ? { ...source.scoreWeights } : {}
  };
}

function resolvedVenueLevel(candidate, policy) {
  if (candidate.venueLevel) return candidate.venueLevel;
  if (candidate.venue) return policy.venueCatalog[normalizeKey(candidate.venue)] || null;
  return null;
}

function createCheck({ key, expected, actual, status, reason, unknownField }) {
  return {
    key,
    status,
    expected: expected ?? null,
    actual: actual ?? null,
    reason,
    ...(unknownField ? { unknownField } : {})
  };
}

function compareVenueLevel(candidate, policy) {
  const actual = resolvedVenueLevel(candidate, policy);
  if (!actual) {
    return createCheck({
      key: 'ccfLevel',
      expected: policy.requiredVenueLevels,
      actual: null,
      status: CHECK_STATUS.UNKNOWN,
      reason: 'CCF level is missing or cannot be verified.',
      unknownField: 'venueLevel'
    });
  }
  const passed = policy.requiredVenueLevels.includes(actual);
  return createCheck({
    key: 'ccfLevel',
    expected: policy.requiredVenueLevels,
    actual,
    status: passed ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    reason: passed
      ? `CCF level ${actual} satisfies the required level.`
      : `CCF level ${actual} is not in the required levels: ${policy.requiredVenueLevels.join(', ')}.`
  });
}

function compareVenue(candidate, policy) {
  if (!candidate.venue) {
    return createCheck({
      key: 'venue',
      expected: policy.allowedVenues,
      actual: null,
      status: CHECK_STATUS.UNKNOWN,
      reason: 'Publication venue is missing.',
      unknownField: 'venue'
    });
  }
  const actualKey = normalizeKey(candidate.venue);
  const allowed = policy.allowedVenues.some((venue) => normalizeKey(venue) === actualKey);
  return createCheck({
    key: 'venue',
    expected: policy.allowedVenues,
    actual: candidate.venue,
    status: allowed ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    reason: allowed
      ? `Venue ${candidate.venue} is allowed.`
      : `Venue ${candidate.venue} is not in the allowed venue list.`
  });
}

function compareYear(candidate, policy) {
  if (candidate.year === null) {
    return createCheck({
      key: 'year',
      expected: { min: policy.minYear, max: policy.maxYear },
      actual: null,
      status: CHECK_STATUS.UNKNOWN,
      reason: 'Publication year is missing or cannot be parsed.',
      unknownField: 'year'
    });
  }
  const tooEarly = policy.minYear !== null && candidate.year < policy.minYear;
  const tooLate = policy.maxYear !== null && candidate.year > policy.maxYear;
  const passed = !tooEarly && !tooLate;
  return createCheck({
    key: 'year',
    expected: { min: policy.minYear, max: policy.maxYear },
    actual: candidate.year,
    status: passed ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    reason: passed
      ? `Publication year ${candidate.year} is within the required range.`
      : `Publication year ${candidate.year} is outside the required range.`
  });
}

function comparePeerReview(candidate) {
  if (candidate.peerReviewed === null) {
    return createCheck({
      key: 'peerReviewed',
      expected: true,
      actual: null,
      status: CHECK_STATUS.UNKNOWN,
      reason: 'Peer-review status is missing or cannot be verified.',
      unknownField: 'peerReviewed'
    });
  }
  return createCheck({
    key: 'peerReviewed',
    expected: true,
    actual: candidate.peerReviewed,
    status: candidate.peerReviewed ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    reason: candidate.peerReviewed
      ? 'Paper is marked as peer reviewed.'
      : 'Paper is marked as not peer reviewed.'
  });
}

function compareCodeAvailability(candidate) {
  if (candidate.hasCode === null) {
    return createCheck({
      key: 'hasCode',
      expected: true,
      actual: null,
      status: CHECK_STATUS.UNKNOWN,
      reason: 'Public code availability is missing or cannot be verified.',
      unknownField: 'hasCode'
    });
  }
  return createCheck({
    key: 'hasCode',
    expected: true,
    actual: candidate.hasCode,
    status: candidate.hasCode ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    reason: candidate.hasCode ? 'A public code link is available.' : 'No public code link was found.'
  });
}

function comparePublicationType(candidate, policy) {
  if (!candidate.publicationType) {
    return createCheck({
      key: 'publicationType',
      expected: policy.allowedPublicationTypes,
      actual: null,
      status: CHECK_STATUS.UNKNOWN,
      reason: 'Publication type is missing or cannot be verified.',
      unknownField: 'publicationType'
    });
  }
  const passed = policy.allowedPublicationTypes.includes(candidate.publicationType);
  return createCheck({
    key: 'publicationType',
    expected: policy.allowedPublicationTypes,
    actual: candidate.publicationType,
    status: passed ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
    reason: passed
      ? `Publication type ${candidate.publicationType} is allowed.`
      : `Publication type ${candidate.publicationType} is not in the allowed types.`
  });
}

function cappedCitationScore(value) {
  if (value === null || value < 0) return 0;
  return Math.min(10, Math.round((Math.log10(value + 1) / 3) * 10));
}

/** Return a deterministic 0-100 metadata/reproducibility score. */
export function scorePaperQuality(candidateInput) {
  const candidate = candidateInput?.title !== undefined
    && Array.isArray(candidateInput?.authors)
    && Object.hasOwn(candidateInput, 'venueLevel')
    ? candidateInput
    : normalizePaperCandidate(candidateInput);
  const breakdown = {
    title: candidate.title ? 10 : 0,
    abstract: candidate.abstract ? 10 : 0,
    authors: candidate.authors.length ? 10 : 0,
    year: candidate.year !== null ? 10 : 0,
    venue: candidate.venue ? 10 : 0,
    venueLevel: candidate.venueLevel ? 5 : 0,
    peerReviewed: candidate.peerReviewed === true ? 15 : 0,
    persistentId: candidate.doi || candidate.id ? 10 : 0,
    citations: cappedCitationScore(candidate.citationCount),
    code: candidate.hasCode === true ? 5 : 0
  };
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return {
    score,
    maxScore: 100,
    breakdown
  };
}

/** Evaluate one candidate against all configured hard filters. */
export function evaluatePaperCandidate(input, policyInput = {}) {
  const candidate = normalizePaperCandidate(input);
  const policy = normalizeQualityPolicy(policyInput);
  const checks = [];

  if (policy.requiredVenueLevels.length) checks.push(compareVenueLevel(candidate, policy));
  if (policy.allowedVenues.length) checks.push(compareVenue(candidate, policy));
  if (policy.allowedPublicationTypes.length) checks.push(comparePublicationType(candidate, policy));
  if (policy.minYear !== null || policy.maxYear !== null) checks.push(compareYear(candidate, policy));
  if (policy.peerReviewedOnly) checks.push(comparePeerReview(candidate));
  if (policy.requireCode) checks.push(compareCodeAvailability(candidate));

  const failed = checks.filter((check) => check.status === CHECK_STATUS.FAIL);
  const unknown = checks.filter((check) => check.status === CHECK_STATUS.UNKNOWN);
  const decision = failed.length
    ? PAPER_DECISIONS.REJECT
    : (unknown.length ? policy.unknownMetadata : PAPER_DECISIONS.ACCEPT);
  const quality = scorePaperQuality(candidate);

  return {
    id: candidate.id,
    candidate,
    decision,
    accepted: decision === PAPER_DECISIONS.ACCEPT,
    qualityScore: quality.score,
    qualityScoreBreakdown: quality.breakdown,
    checks,
    reasons: checks.map((check) => check.reason),
    unknownFields: unique(checks.map((check) => check.unknownField)),
    metadata: {
      complete: Boolean(candidate.title && candidate.authors.length && candidate.year && candidate.abstract && candidate.url),
      missing: ['title', 'authors', 'year', 'abstract', 'url'].filter((field) => {
        const value = candidate[field];
        return Array.isArray(value) ? value.length === 0 : value === null || value === undefined || value === '';
      })
    },
    source: candidate.source,
    sourceCount: candidate.sourceCount,
    policy
  };
}

export const evaluatePaper = evaluatePaperCandidate;

/** Evaluate a batch without changing ordering or making network calls. */
export function filterPaperCandidates(candidates, policyInput = {}) {
  const policy = normalizeQualityPolicy(policyInput);
  const results = normalizePaperCandidates(candidates).map((candidate) => evaluatePaperCandidate(candidate, policy));
  return {
    policy,
    results,
    accepted: results.filter((result) => result.decision === PAPER_DECISIONS.ACCEPT),
    rejected: results.filter((result) => result.decision === PAPER_DECISIONS.REJECT),
    needsReview: results.filter((result) => result.decision === PAPER_DECISIONS.NEEDS_REVIEW),
    summary: {
      total: results.length,
      accepted: results.filter((result) => result.decision === PAPER_DECISIONS.ACCEPT).length,
      rejected: results.filter((result) => result.decision === PAPER_DECISIONS.REJECT).length,
      needsReview: results.filter((result) => result.decision === PAPER_DECISIONS.NEEDS_REVIEW).length
    }
  };
}

export const applyQualityGate = filterPaperCandidates;
export const evaluatePapers = filterPaperCandidates;
export const DEFAULT_POLICY = DEFAULT_QUALITY_POLICY;
