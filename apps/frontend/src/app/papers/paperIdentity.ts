type PaperIdentity = { doi?: string | null; arxivId?: string | null; url?: string | null };
const text = (value?: string | null) => value?.trim() || '';
const doi = (value?: string | null) => text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
function arxiv(paper: PaperIdentity) {
  const value = text(paper.arxivId) || (/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i.test(text(paper.url)) ? text(paper.url) : '');
  return value.replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/^arxiv:\s*/i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
}
function url(value?: string | null) {
  try {
    const parsed = new URL(text(value));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch { return ''; }
}

/** Keep the UI's strong-identity conflict rule aligned with backend import. */
export function matchPaper(paper: PaperIdentity, candidate: PaperIdentity) {
  const leftDoi = doi(paper.doi), rightDoi = doi(candidate.doi);
  const leftArxiv = arxiv(paper), rightArxiv = arxiv(candidate);
  if (leftDoi && rightDoi && leftDoi !== rightDoi) return false;
  if (leftArxiv && rightArxiv && leftArxiv !== rightArxiv) return false;
  if (leftDoi && leftDoi === rightDoi) return true;
  if (leftArxiv && leftArxiv === rightArxiv) return true;
  const candidateUrl = url(candidate.url);
  return !!candidateUrl && url(paper.url) === candidateUrl;
}

/** Ambiguous matches go through backend import/409; never choose by array order. */
export function findUniquePaper<T extends PaperIdentity>(papers: T[], candidate: PaperIdentity): T | undefined {
  const matches = papers.filter(paper => matchPaper(paper, candidate));
  return matches.length === 1 ? matches[0] : undefined;
}
