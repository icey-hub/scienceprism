import { useEffect, useRef, useState } from 'react';
import { importProjectPaper, listProjectPapers, type PaperLibraryRecord } from '../../api/projectAdapter';
import { loadPaperSearches, searchProjectPapers, type PaperSearchHistory, type SearchCandidate, type SearchCriteria } from '../../api/paperSearchAdapter';

function errorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  try { return JSON.parse(message).error?.message || message; } catch { return message; }
}
function arxivIdentity(value?: string) { return value?.replace(/v\d+$/, '').toLowerCase(); }
export function matchPaper(paper: PaperLibraryRecord, candidate: SearchCandidate) {
  if (candidate.doi && paper.doi?.toLowerCase() === candidate.doi.toLowerCase()) return true;
  if (candidate.arxivId && arxivIdentity(paper.arxivId) === arxivIdentity(candidate.arxivId)) return true;
  return !!candidate.url && candidate.url === paper.url;
}

export function usePaperSearch(projectId: string) {
  const [data, setData] = useState<PaperSearchHistory | null>(null);
  const [papers, setPapers] = useState<PaperLibraryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    Promise.all([loadPaperSearches(projectId, abort.signal), listProjectPapers(projectId)])
      .then(([history, library]) => { if (!abort.signal.aborted) { setData(history); setPapers(library.papers); } })
      .catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; abort.abort(); current.current?.abort(); };
  }, [projectId]);

  const search = async (criteria: SearchCriteria) => {
    current.current?.abort();
    const abort = new AbortController(); current.current = abort;
    setBusy(true); setError(''); setNotice('');
    try {
      const { session } = await searchProjectPapers(projectId, criteria, abort.signal);
      if (abort.signal.aborted || !mounted.current) return null;
      setData(value => value ? { ...value, sessions: [session, ...value.sessions].slice(0, 30) } : value);
      return session;
    } catch (cause) {
      if (!abort.signal.aborted && mounted.current) setError(errorMessage(cause));
      return null;
    } finally {
      if (current.current === abort && mounted.current) { current.current = null; setBusy(false); }
    }
  };
  const cancel = () => { current.current?.abort(); current.current = null; setBusy(false); setNotice('已取消检索，已有结果保留。'); };
  const save = async (candidate: SearchCandidate) => {
    if (saving) return;
    setSaving(candidate.id); setError('');
    try {
      const { result } = await importProjectPaper(projectId, {
        title: candidate.title, authors: candidate.authors, abstract: candidate.abstract,
        year: candidate.year, url: candidate.url, doi: candidate.doi, arxivId: candidate.arxivId, venue: candidate.venue,
        source: { provider: candidate.source, url: candidate.url },
        sourceRecords: [{ ...candidate.sourceRecord, provider: candidate.source, retrievedAt: candidate.retrievedAt }]
      });
      if (!mounted.current) return;
      setPapers(value => [...value.filter(paper => paper.id !== result.paper.id), result.paper]);
      setNotice(result.duplicate ? '文献已在资料库，来源信息已合并。' : '已加入文献库。');
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setSaving(null); }
  };
  return { data, papers, loading, busy, saving, error, notice, search, cancel, save };
}
