import { basicSetup } from 'codemirror';
import { latex } from '../../latex/lang';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet, WidgetType, gutter, GutterMarker } from '@codemirror/view';
import { search } from '@codemirror/search';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { lintGutter } from '@codemirror/lint';
import { foldService, indentOnInput } from '@codemirror/language';

const SECTION_LEVELS: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5
};

const SECTION_RE = /\\(section|subsection|subsubsection|paragraph|subparagraph)\*?\b/;
const ENV_RE = /\\(begin|end)\{([^}]+)\}/g;
const IF_START_RE = /\\if[a-zA-Z@]*\b/g;
const IF_END_RE = /\\fi\b/g;
const IF_START_TEST = /\\if[a-zA-Z@]*\b/;
const GROUP_START_RE = /\\begingroup\b/g;
const GROUP_END_RE = /\\endgroup\b/g;
const GROUP_START_TEST = /\\begingroup\b/;

function stripLatexComment(text: string) {
  let result = '';
  let escaped = false;
  for (const ch of text) {
    if (ch === '%' && !escaped) break;
    result += ch;
    if (ch === '\\' && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return result;
}

function findEnvFold(state: EditorState, startLineNumber: number, lineEnd: number, env: string) {
  let depth = 1;
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    let match: RegExpExecArray | null;
    ENV_RE.lastIndex = 0;
    while ((match = ENV_RE.exec(clean)) !== null) {
      const kind = match[1];
      const name = match[2];
      if (name !== env) continue;
      if (kind === 'begin') depth += 1;
      if (kind === 'end') depth -= 1;
      if (depth === 0) {
        if (line.from > lineEnd) {
          return { from: lineEnd, to: line.from };
        }
        return null;
      }
    }
  }
  return null;
}

function findSectionFold(state: EditorState, startLineNumber: number, lineEnd: number, level: number) {
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    const match = clean.match(SECTION_RE);
    if (!match) continue;
    const nextLevel = SECTION_LEVELS[match[1]] ?? 99;
    if (nextLevel <= level) {
      if (line.from > lineEnd) {
        return { from: lineEnd, to: line.from };
      }
      return null;
    }
  }
  if (state.doc.length > lineEnd) {
    return { from: lineEnd, to: state.doc.length };
  }
  return null;
}

function countRegex(text: string, re: RegExp) {
  let count = 0;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    count += 1;
  }
  return count;
}

function countUnescapedToken(text: string, token: string) {
  let count = 0;
  for (let i = 0; i <= text.length - token.length; i += 1) {
    if (text.slice(i, i + token.length) !== token) continue;
    if (i > 0 && text[i - 1] === '\\') continue;
    count += 1;
    i += token.length - 1;
  }
  return count;
}

function findTokenFold(
  state: EditorState,
  startLineNumber: number,
  lineEnd: number,
  startRe: RegExp,
  endRe: RegExp
) {
  let depth = 1;
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    depth += countRegex(clean, startRe);
    depth -= countRegex(clean, endRe);
    if (depth <= 0) {
      if (line.from > lineEnd) {
        return { from: lineEnd, to: line.from };
      }
      return null;
    }
  }
  return null;
}

function findDisplayMathFold(
  state: EditorState,
  startLineNumber: number,
  lineEnd: number,
  startToken: string,
  endToken: string
) {
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    if (countUnescapedToken(clean, endToken) > 0) {
      if (line.from > lineEnd) {
        return { from: lineEnd, to: line.from };
      }
      return null;
    }
  }
  return null;
}

function latexFoldService(state: EditorState, lineStart: number, lineEnd: number) {
  const line = state.doc.lineAt(lineStart);
  const clean = stripLatexComment(line.text);
  if (!clean.trim()) return null;
  const envMatch = clean.match(/\\begin\{([^}]+)\}/);
  if (envMatch) {
    return findEnvFold(state, line.number, lineEnd, envMatch[1]);
  }
  const sectionMatch = clean.match(SECTION_RE);
  if (sectionMatch) {
    const level = SECTION_LEVELS[sectionMatch[1]] ?? 99;
    return findSectionFold(state, line.number, lineEnd, level);
  }
  if (GROUP_START_TEST.test(clean)) {
    return findTokenFold(state, line.number, lineEnd, GROUP_START_RE, GROUP_END_RE);
  }
  if (IF_START_TEST.test(clean)) {
    return findTokenFold(state, line.number, lineEnd, IF_START_RE, IF_END_RE);
  }
  const hasDisplayDollar = countUnescapedToken(clean, '$$') % 2 === 1;
  if (hasDisplayDollar) {
    return findDisplayMathFold(state, line.number, lineEnd, '$$', '$$');
  }
  const hasDisplayBracket = clean.includes('\\[');
  if (hasDisplayBracket && !clean.includes('\\]')) {
    return findDisplayMathFold(state, line.number, lineEnd, '\\[', '\\]');
  }
  return null;
}

function latexCompletionSource(context: CompletionContext) {
  const before = context.matchBefore(/[\\/][A-Za-z]*$/);
  if (!before) return null;
  const prev = before.from > 0 ? context.state.doc.sliceString(before.from - 1, before.from) : ' ';
  if (prev && !/[\s({\n]/.test(prev)) return null;
  if (before.text.startsWith('/') && prev === ':') return null;
  const options = [
    { label: '\\section{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\section{}' },
        selection: { anchor: from + '\\section{'.length }
      });
    }},
    { label: '\\subsection{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\subsection{}' },
        selection: { anchor: from + '\\subsection{'.length }
      });
    }},
    { label: '\\subsubsection{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\subsubsection{}' },
        selection: { anchor: from + '\\subsubsection{'.length }
      });
    }},
    { label: '\\paragraph{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\paragraph{}' },
        selection: { anchor: from + '\\paragraph{'.length }
      });
    }},
    { label: '\\cite{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\cite{}' },
        selection: { anchor: from + '\\cite{'.length }
      });
    }},
    { label: '\\ref{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\ref{}' },
        selection: { anchor: from + '\\ref{'.length }
      });
    }},
    { label: '\\label{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\label{}' },
        selection: { anchor: from + '\\label{'.length }
      });
    }},
    { label: '\\begin{itemize}', type: 'keyword', apply: '\\begin{itemize}\n\\item \n\\end{itemize}' },
    { label: '\\begin{enumerate}', type: 'keyword', apply: '\\begin{enumerate}\n\\item \n\\end{enumerate}' },
    { label: '\\begin{figure}', type: 'keyword', apply: '\\begin{figure}[t]\n\\centering\n\\includegraphics[width=0.9\\linewidth]{}\n\\caption{}\n\\label{}\n\\end{figure}' },
    { label: '\\begin{table}', type: 'keyword', apply: '\\begin{table}[t]\n\\centering\n\\begin{tabular}{}\n\\end{tabular}\n\\caption{}\n\\label{}\n\\end{table}' }
  ];
  return {
    from: before.from,
    options,
    validFor: /^[\\/][A-Za-z]*$/
  };
}

export const setGhostEffect = StateEffect.define<{ pos: number | null; text: string }>();

class GhostWidget extends WidgetType {
  constructor(private text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) {
        const { pos, text } = effect.value;
        if (pos == null || !text) {
          return Decoration.none;
        }
        const widget = Decoration.widget({
          widget: new GhostWidget(text),
          side: 1
        });
        return Decoration.set([widget.range(pos)]);
      }
    }
    if (tr.docChanged || tr.selection) {
      return Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/* ── LaTeX environment scope colorization ── */
const SCOPE_COLORS = [
  'rgba(180, 74, 47, 0.5)',
  'rgba(59, 130, 186, 0.5)',
  'rgba(76, 159, 88, 0.5)',
  'rgba(180, 137, 47, 0.5)',
  'rgba(142, 68, 173, 0.5)',
  'rgba(211, 84, 0, 0.5)',
];

function computeEnvDepths(doc: { lines: number; line: (n: number) => { text: string } }): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = 1; i <= doc.lines; i++) {
    const clean = stripLatexComment(doc.line(i).text);
    ENV_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const events: { pos: number; delta: number }[] = [];
    while ((match = ENV_RE.exec(clean)) !== null) {
      events.push({ pos: match.index, delta: match[1] === 'begin' ? 1 : -1 });
    }
    events.sort((a, b) => a.pos - b.pos);
    let lineDepth = depth;
    for (const ev of events) {
      if (ev.delta < 0) { depth--; lineDepth = Math.min(lineDepth, depth); }
      else { depth++; }
    }
    depths.push(Math.max(0, lineDepth));
  }
  return depths;
}

const envDepthField = StateField.define<number[]>({
  create(state) { return computeEnvDepths(state.doc); },
  update(value, tr) {
    if (tr.docChanged) return computeEnvDepths(tr.state.doc);
    return value;
  },
});

class ScopeMarker extends GutterMarker {
  constructor(readonly depth: number) { super(); }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-scope-marker';
    for (let i = 0; i < this.depth; i++) {
      const bar = document.createElement('span');
      bar.className = 'cm-scope-bar';
      bar.style.backgroundColor = SCOPE_COLORS[i % SCOPE_COLORS.length];
      wrap.appendChild(bar);
    }
    return wrap;
  }
}

const scopeGutter = gutter({
  class: 'cm-scope-gutter',
  lineMarker(view, line) {
    const depths = view.state.field(envDepthField);
    const lineNo = view.state.doc.lineAt(line.from).number;
    const d = depths[lineNo - 1] || 0;
    return d > 0 ? new ScopeMarker(d) : null;
  },
});

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      background: 'transparent'
    },
    '.cm-scroller': {
      fontFamily: '"JetBrains Mono", "SF Mono", "Menlo", monospace',
      fontSize: 'var(--editor-font-size, 11px)',
      lineHeight: '1.6'
    },
    '.cm-content': {
      padding: '16px'
    },
    '.cm-gutters': {
      background: 'transparent',
      border: 'none',
      color: 'rgba(122, 111, 103, 0.6)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px'
    },
    '.cm-activeLine': {
      background: 'rgba(180, 74, 47, 0.08)'
    },
    '.cm-activeLineGutter': {
      background: 'transparent'
    },
    '.cm-selectionBackground': {
      background: 'rgba(180, 74, 47, 0.18)'
    }
  },
  { dark: false }
);

export function editorExtensions(collaboration: Extension): Extension[] {
  return [basicSetup, lintGutter(), latex(), envDepthField, scopeGutter,
    indentOnInput(), foldService.of(latexFoldService), EditorView.lineWrapping,
    editorTheme, collaboration, ghostField, search(),
    autocompletion({ override: [latexCompletionSource] })];
}
