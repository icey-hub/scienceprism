import type { Diagnostic } from '@codemirror/lint';
import type { CompileInputSnapshot } from '../../api/client';

/** Candidate text becomes diagnostic input only after matching the server's bytes. */
export async function matchesCompileInput(snapshot: CompileInputSnapshot | undefined, file: string, source: string) {
  const entry = snapshot?.files.find((item) => item.path === file);
  if (!entry || !globalThis.crypto?.subtle) return false;
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength !== entry.bytes) return false;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return hash === entry.sha256;
  } catch { return false; }
}

export interface CompileError {
  message: string;
  line?: number;
  file?: string;
}

export function parseCompileErrors(log: string, _mainFile: string): CompileError[] {
  const errors: CompileError[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    const location = /^(?:error:\s*)?(.+?\.tex):(\d+):\s*(.+)$/.exec(line);
    if (location && !/\bwarning\b/i.test(line) && !/^note:/i.test(line)) {
      const lineNo = Number(location[2]);
      errors.push({ file: location[1], line: Number.isSafeInteger(lineNo) && lineNo > 0 ? lineNo : undefined, message: location[3] });
    } else if (line.startsWith('!')) {
      // Traditional TeX logs do not establish file identity via l.N or the main file.
      errors.push({ message: line.replace(/^!+\s*/, '') });
    }
  }
  return errors.filter((error, index) => errors.findIndex((other) =>
    other.file === error.file && other.line === error.line &&
    other.message.replace(/[.\s]+$/, '') === error.message.replace(/[.\s]+$/, '')
  ) === index);
}

export function resolveCompileFile(file: string, paths: string[]) {
  if (!file || file.includes('\0') || file.includes('://') || file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\')) return undefined;
  const normalized = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!normalized || normalized.split('/').includes('..') || normalized.split('/').includes('.')) return undefined;
  return paths.includes(normalized) ? normalized : undefined;
}

export function compileDiagnostics(errors: CompileError[], file: string, source: string): Diagnostic[] {
  const lines = source.split('\n');
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i += 1) offsets.push(offsets[i] + lines[i].length + 1);
  return errors.flatMap((error) => {
    if (error.file !== file || !error.line || !Number.isSafeInteger(error.line) || error.line < 1 || error.line > lines.length) return [];
    const from = offsets[error.line - 1];
    return [{ from, to: from + lines[error.line - 1].length, severity: 'error', message: error.message }];
  });
}
