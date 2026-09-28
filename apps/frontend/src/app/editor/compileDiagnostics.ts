import type { Diagnostic } from '@codemirror/lint';

export interface CompileError {
  message: string;
  line?: number;
  file?: string;
}

export function parseCompileErrors(log: string, mainFile: string): CompileError[] {
  const lines = log.split('\n');
  const errors: CompileError[] = [];
  let currentFile = mainFile;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const location = /^(?:error:\s*)?(.+?\.tex):(\d+):\s*(.+)$/.exec(line);
    if (location && !/\bwarning\b/i.test(line) && !/^note:/i.test(line)) {
      currentFile = location[1];
      errors.push({ file: currentFile, line: Number(location[2]), message: location[3] });
    } else if (line.startsWith('!')) {
      const message = line.replace(/^!+\s*/, '');
      let lineNo: number | undefined;
      for (const next of lines.slice(i + 1, i + 8)) {
        if (next.trim().startsWith('!')) break;
        const match = /^\s*l\.(\d+)\b/.exec(next);
        if (match) { lineNo = Number(match[1]); break; }
      }
      errors.push({ file: currentFile, line: lineNo, message });
    }
  }
  return errors.filter((error, index) => errors.findIndex((other) =>
    other.file === error.file && other.line === error.line &&
    other.message.replace(/[.\s]+$/, '') === error.message.replace(/[.\s]+$/, '')
  ) === index);
}

export function resolveCompileFile(file: string, paths: string[]) {
  const normalized = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (paths.includes(normalized)) return normalized;
  const matches = paths.filter((path) => normalized.endsWith(`/${path}`) || path.endsWith(`/${normalized}`));
  return matches.length === 1 ? matches[0] : undefined;
}

export function compileDiagnostics(errors: CompileError[], file: string, source: string): Diagnostic[] {
  const lines = source.split('\n');
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i += 1) offsets.push(offsets[i] + lines[i].length + 1);
  return errors.flatMap((error) => {
    if (error.file !== file || !error.line || error.line > lines.length) return [];
    const from = offsets[error.line - 1];
    return [{ from, to: from + lines[error.line - 1].length, severity: 'error', message: error.message }];
  });
}
