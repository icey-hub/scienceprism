/** Keep toolbar content inside a complete LaTeX document's body. */
export function getLatexBodyInsertionRange(source: string, from: number, to: number) {
  // Mask comments without changing offsets; escaped percent signs remain text.
  const uncommented = source.replace(/\\[%\\]|%[^\r\n]*/g, (match) =>
    match.startsWith('%') ? ' '.repeat(match.length) : match
  );
  const begin = /\\begin\s*\{\s*document\s*\}/.exec(uncommented);
  if (!begin) return { from, to };
  const bodyStart = begin.index + begin[0].length;
  const end = /\\end\s*\{\s*document\s*\}/.exec(uncommented.slice(bodyStart));
  if (!end) return { from, to };
  const bodyEnd = bodyStart + end.index;

  // Collapse selections outside the body so structural commands are preserved.
  if (from < bodyStart) return { from: bodyStart, to: bodyStart };
  if (to > bodyEnd) return { from: bodyEnd, to: bodyEnd };
  return { from, to };
}
