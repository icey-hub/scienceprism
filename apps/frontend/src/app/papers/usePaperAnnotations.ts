import { useEffect, useMemo, useState } from 'react';
import { createAnnotation, deleteAnnotation, getAnnotations, updateAnnotation, type AnnotationState, type ReadingSelection, type TranslationResult } from '../../api/paperReaderAdapter';
import { createAnnotationRequests } from './annotationRequests';
export function usePaperAnnotations(projectId: string, paperId: string) {
  const [data, setData] = useState<AnnotationState | null>(null);
  const [error, setError] = useState('');
  const requests = useMemo(() => createAnnotationRequests(
    signal => getAnnotations(projectId, paperId, signal),
    value => { setData(value); setError(''); }
  ), [projectId, paperId]);
  useEffect(() => {
    let active = true;
    requests.activate(); setData(null); setError('');
    void requests.refresh().catch(() => { if (active) setError('批注暂时无法读取，请重试。'); });
    return () => { active = false; requests.dispose(); };
  }, [requests]);
  const { refresh, change } = requests;
  const save = (selection: ReadingSelection, translation: TranslationResult | null) => change(revision => {
    const { id: _id, text, ...anchor } = selection;
    return createAnnotation(projectId, paperId, revision, { text: '', anchor: { ...anchor, quote: text }, translation: translation ? { sourceText: text, translatedText: translation.translatedText, providerId: translation.providerId, translatedAt: translation.translatedAt } : null });
  });
  return { data, error, refresh, save,
    add: (text: string) => change(revision => createAnnotation(projectId, paperId, revision, { text })),
    edit: (id: string, text: string) => change(revision => updateAnnotation(projectId, paperId, id, revision, text)),
    remove: (id: string) => change(revision => deleteAnnotation(projectId, paperId, id, revision)) };
}
