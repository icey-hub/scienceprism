/** Coordinate the reader's transient snapshot, not a second annotation store. */
export function createAnnotationRequests<T extends { revision: string }>(load: (signal: AbortSignal) => Promise<T>, publish: (value: T) => void) {
  let active = false;
  let sequence = 0;
  let snapshot: T | null = null;
  let reading: AbortController | null = null;
  let writing: Promise<T> | null = null;
  const invalidateRead = () => { sequence++; reading?.abort(); reading = null; };
  return {
    activate() { active = true; },
    dispose() { active = false; invalidateRead(); },
    async refresh() {
      // A GET started before a POST commits could bring back its old revision.
      // Refreshes requested during a write must wait for that write to settle.
      while (writing) await writing.catch(() => {});
      if (!active) return;
      invalidateRead();
      const ticket = sequence;
      const abort = new AbortController(); reading = abort;
      try {
        const value = await load(abort.signal);
        if (active && ticket === sequence) { snapshot = value; publish(value); }
      } catch (cause) {
        if (active && ticket === sequence) throw cause;
      } finally { if (reading === abort) reading = null; }
    },
    async change(work: (revision: string) => Promise<T>) {
      if (!active || !snapshot || writing) throw new Error('批注正在读取或保存，请稍后重试。');
      invalidateRead();
      const ticket = sequence;
      const revision = snapshot.revision;
      const operation = Promise.resolve().then(() => work(revision));
      writing = operation;
      try {
        const value = await operation;
        if (active && ticket === sequence) { snapshot = value; publish(value); }
      } finally { if (writing === operation) writing = null; }
    }
  };
}
