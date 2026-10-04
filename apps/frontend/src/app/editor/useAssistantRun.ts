import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelHarnessRun, listHarnessRuns, startAssistantRun } from '../../api/assistantAdapter';
import type { AssistantRunInput, HarnessRun } from '../../api/assistantAdapter';

export const isRunActive = (run: HarnessRun) => ['created', 'running', 'paused'].includes(run.status);

/** Server Runs own history and execution; leaving the page only stops polling. */
export function useAssistantRun(projectId: string) {
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const scope = useRef(projectId);
  scope.current = projectId;
  const revision = useRef(0);
  const submitting = useRef(false);
  const uncertain = useRef<AssistantRunInput | null>(null);
  const activeRun = runs.find(isRunActive);

  const remember = useCallback((run: HarnessRun) => {
    if (scope.current !== run.projectId) return;
    revision.current += 1;
    setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setRuns([]);
    setLoading(true);
    setError('');
    setStarting(false);
    setStopping(false);
    uncertain.current = null;
    submitting.current = false;
    const poll = async () => {
      const captured = revision.current;
      try {
        const result = await listHarnessRuns(projectId, { source: 'editor', limit: '100' });
        if (!disposed && revision.current === captured) {
          setRuns(result.runs);
          setLoading(false);
        }
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        if (!disposed) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);

  const start = async (
    input: Omit<AssistantRunInput, 'requestId' | 'documentVersions'>,
    prepare: () => Promise<NonNullable<AssistantRunInput['documentVersions']>>
  ) => {
    if (submitting.current || activeRun || loading) return false;
    submitting.current = true;
    setStarting(true);
    setError('');
    const owner = projectId;
    try {
      // Save errors abort before allocating a task or calling the model.
      const documentVersions = await prepare();
      if (scope.current !== owner) return false;
      const candidate = { ...input, documentVersions };
      const previous = uncertain.current;
      if (previous && JSON.stringify({ ...previous, requestId: undefined }) !== JSON.stringify(candidate)) {
        // Resolve an ambiguous POST before creating another task.
        const found = await listHarnessRuns(owner, { source: 'editor', requestId: previous.requestId, limit: '1' });
        if (found.runs[0]) {
          remember(found.runs[0]);
          uncertain.current = null;
          if (isRunActive(found.runs[0])) return false;
        }
      }
      const request = previous && JSON.stringify({ ...previous, requestId: undefined }) === JSON.stringify(candidate)
        ? previous : { ...candidate, requestId: crypto.randomUUID() };
      uncertain.current = request;
      const { run } = await startAssistantRun(owner, request);
      if (scope.current !== owner) return false;
      uncertain.current = null;
      remember(run);
      return true;
    } catch (cause) {
      if (scope.current === owner) setError(String(cause));
      return false;
    } finally {
      if (scope.current === owner) {
        submitting.current = false;
        setStarting(false);
      }
    }
  };

  const stop = async () => {
    if (!activeRun || stopping) return;
    setStopping(true);
    setError('');
    try { remember((await cancelHarnessRun(projectId, activeRun.id)).run); }
    catch (cause) { if (scope.current === projectId) setError(String(cause)); }
    finally { if (scope.current === projectId) setStopping(false); }
  };

  const history = [...runs].reverse().flatMap((run) => [
    { role: 'user' as const, content: run.request?.prompt || run.task },
    ...(run.reply ? [{ role: 'assistant' as const, content: run.reply }] : [])
  ]).slice(-8);

  return { runs, history, activeRun, loading, starting, stopping, error, start, stop, remember,
    busy: loading || starting || Boolean(activeRun) };
}
