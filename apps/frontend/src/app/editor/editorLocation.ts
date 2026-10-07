const lastFile = new Map<string, string>();
const storageKey = (projectId: string) => `scienceprism-editor-file:${projectId}`;

export function rememberEditorFile(projectId: string, path: string) {
  lastFile.set(projectId, path);
  try { localStorage.setItem(storageKey(projectId), path); } catch { /* Keep navigation available when storage is full or disabled. */ }
}

export function restoredEditorFile(projectId: string, files: string[]) {
  let path = lastFile.get(projectId);
  if (path === undefined) {
    try { path = localStorage.getItem(storageKey(projectId)) ?? ''; } catch { path = ''; }
  }
  return files.includes(path) ? path : '';
}
