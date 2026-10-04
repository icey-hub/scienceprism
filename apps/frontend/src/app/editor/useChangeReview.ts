import { useMemo, useRef, useState } from 'react';
import { applyHarnessRunPatches, decideHarnessRun } from '../../api/assistantAdapter';
import type { HarnessRun } from '../../api/assistantAdapter';

export interface PendingChange {
  runId: string;
  filePath: string;
  original: string;
  proposed: string;
  diff: string;
  deleted?: boolean;
}

export function useChangeReview(projectId: string, runs: HarnessRun[], remember: (run: HarnessRun) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const pending = useMemo(() => runs.flatMap((run) => (run.patches || [])
    .filter((patch) => !run.appliedPatches?.includes(patch.path) && run.patchDecisions?.[patch.path]?.status !== 'rejected'
      && !(run.humanDecision?.status === 'rejected' && !run.patchDecisions))
    .map((patch) => ({ runId: run.id, filePath: patch.path, original: patch.original ?? '',
      proposed: patch.content ?? '', diff: patch.diff ?? '', deleted: patch.deleted }))), [runs]);

  const review = async (changes: PendingChange[], decision: 'accept' | 'reject', apply: (work: () => Promise<void>, changes: PendingChange[]) => Promise<void>) => {
    if (lock.current || !changes.length) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const work = async () => {
        const runIds = [...new Set(changes.map((change) => change.runId))];
        for (const runId of runIds) {
          const paths = changes.filter((change) => change.runId === runId).map((change) => change.filePath);
          remember((await decideHarnessRun(projectId, runId, decision, '', paths)).run);
          if (decision === 'accept') remember((await applyHarnessRunPatches(projectId, runId, paths)).run);
        }
      };
      if (decision === 'accept') await apply(work, changes);
      else await work();
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { pending, busy, error, review };
}
