import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjects, type PaperLibraryRecord } from '../../api/client';
import { cancelDownload, downloadPaper, getAttachments, getPaper, readerError, uploadPaper, type AttachmentState } from '../../api/paperReaderAdapter';

export function usePaperReader(projectId: string, paperId: string) {
  const [projectName, setProjectName] = useState('');
  const [paper, setPaper] = useState<PaperLibraryRecord | null>(null);
  const [attachments, setAttachments] = useState<AttachmentState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const attachmentRequest = useRef(0);
  const fetchAttachments = useCallback(async (signal?: AbortSignal) => {
    const version = ++attachmentRequest.current;
    const files = await getAttachments(projectId, paperId, signal);
    if (mounted.current && !signal?.aborted && version === attachmentRequest.current) setAttachments(files);
  }, [projectId, paperId]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [record] = await Promise.all([getPaper(projectId, paperId, signal), fetchAttachments(signal)]);
    if (mounted.current && !signal?.aborted) setPaper(record.paper);
  }, [projectId, paperId, fetchAttachments]);
  useEffect(() => {
    mounted.current = true;
    void listProjects().then(result => { if (mounted.current) setProjectName(result.projects.find(item => item.id === projectId)?.name || ''); }).catch(() => {});
    const abort = new AbortController();
    void refresh(abort.signal).catch(cause => { if (!abort.signal.aborted) setError(readerError(cause)); });
    return () => { mounted.current = false; abort.abort(); };
  }, [refresh]);
  const running = attachments?.jobs.some(job => ['queued', 'running'].includes(job.status));
  useEffect(() => {
    if (!running) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await fetchAttachments(abort.signal); }
      catch (cause) { if (!abort.signal.aborted) setError(readerError(cause)); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 1000); }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [fetchAttachments, running]);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await refresh(); } catch (cause) { if (mounted.current) setError(readerError(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return { projectName, paper, attachments, error, busy, refresh,
    download: (renew = false) => perform(() => downloadPaper(projectId, paperId, renew)),
    upload: (file: File) => perform(() => uploadPaper(projectId, paperId, file)),
    cancel: (id: string) => perform(() => cancelDownload(projectId, paperId, id)) };
}
