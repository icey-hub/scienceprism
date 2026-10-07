import { useCallback, useEffect, useMemo } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router-dom';
import { getFile, writeFile } from '../../api/projectAdapter';
import type { FileVersion } from '../../api/assistantAdapter';

type Draft = { content: string; saved: string; version: FileVersion };

/** Keep every opened draft and its saved baseline, including inactive tabs. */
export function useDocumentDrafts(projectId: string) {
  const drafts = useMemo(() => {
    const files = new Map<string, Draft>();
    let queue = Promise.resolve() as Promise<unknown>;
    const exclusive = <T,>(work: () => Promise<T>): Promise<T> => {
      const job = queue.catch(() => {}).then(work);
      queue = job;
      return job;
    };
    return {
      hasUnsaved: () => [...files.values()].some(draft => draft.content !== draft.saved),
      get: (path: string) => files.get(path),
      loaded: (path: string, content: string, version: FileVersion) => {
        files.set(path, { content, saved: content, version });
      },
      persisted: (path: string, content: string, version: FileVersion, previous?: string) => {
        const draft = files.get(path);
        files.set(path, { content: draft && draft.content !== previous ? draft.content : content, saved: content, version });
      },
      changed: (path: string, content: string) => {
        const draft = files.get(path);
        if (draft) draft.content = content;
      },
      forget: (path: string) => {
        for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      },
      rename: (from: string, to: string) => {
        for (const [path, draft] of [...files]) {
          if (path === from || path.startsWith(`${from}/`)) {
            files.delete(path);
            files.set(`${to}${path.slice(from.length)}`, draft);
          }
        }
      },
      exclusive,
      save: () => exclusive(async () => {
        for (const [path, draft] of files) {
          if (draft.content === draft.saved) continue;
          const content = draft.content;
          const result = await writeFile(projectId, path, content, draft.version);
          if (!result.ok) throw new Error(`Save failed: ${path}`);
          draft.saved = content;
          draft.version = result.version;
        }
      }),
      versions: () => exclusive(async () => {
        const captured = [...files].map(([path, draft]) => ({ path, content: draft.content }));
        const versions: (FileVersion & { path: string })[] = [];
        for (const { path, content } of captured) {
          const draft = files.get(path)!;
          if (content !== draft.saved) throw new Error(`Document changed while saving: ${path}`);
          const stored = await getFile(projectId, path);
          if (stored.content !== content) throw new Error(`Document changed on disk: ${path}`);
          versions.push({ path, ...stored.version });
        }
        for (const { path, content } of captured) {
          if (files.get(path)?.content !== content) throw new Error(`Document changed while saving: ${path}`);
        }
        return versions;
      })
    };
  }, [projectId]);
  const blocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) =>
    currentLocation.pathname !== nextLocation.pathname && drafts.hasUnsaved(), [drafts]));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('还有未保存的文稿修改。离开会丢失这些修改，确定离开吗？')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    const guardExit = (event: BeforeUnloadEvent) => {
      if (!drafts.hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guardExit);
    return () => window.removeEventListener('beforeunload', guardExit);
  }, [drafts]);
  return drafts;
}
