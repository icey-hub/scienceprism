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

/** A saved citation range is valid only in its exact, clean document snapshot. */
export function citationNavigationRange(params: URLSearchParams, content: string, version: { exists: boolean; sha256: string | null } | undefined, dirty: boolean) {
  const expected = params.get('version');
  if (!expected && !params.has('from') && !params.has('to')) return null;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('引用定位版本无效，请重新打开保存回执。');
  if (dirty || !version?.exists || version.sha256 !== expected) throw new Error('文稿已变化或有未保存修改，保留当前内容；请按引用键查找。');
  const rawFrom = params.get('from') || '', rawTo = params.get('to') || '';
  const from = Number(rawFrom), to = Number(rawTo);
  if (!/^\d+$/.test(rawFrom) || !/^\d+$/.test(rawTo) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > content.length) throw new Error('引用范围无效，请重新打开保存回执。');
  return { from, to };
}
