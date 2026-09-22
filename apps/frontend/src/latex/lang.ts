import { StreamLanguage } from '@codemirror/language';

// Simple LaTeX mode for CodeMirror 6
const latexMode = {
  languageData: {
    commentTokens: { line: '%' }
  },
  startState: () => ({
    inMathMode: false,
    inComment: false
  }),

  token: (stream: any, state: any) => {
    // Comments
    if (stream.match(/^%.*$/)) {
      return 'comment';
    }

    // Math mode delimiters
    if (stream.match(/^\$\$/)) {
      state.inMathMode = !state.inMathMode;
      return 'keyword';
    }
    if (stream.match(/^\$/)) {
      state.inMathMode = !state.inMathMode;
      return 'keyword';
    }

    // Commands
    if (stream.match(/^\\[a-zA-Z@]+/)) {
      return 'keyword';
    }

    // Special characters
    if (stream.match(/^[{}[\]]/)) {
      return 'bracket';
    }

    // Math mode content
    if (state.inMathMode) {
      stream.next();
      return 'number';
    }

    stream.next();
    return null;
  }
};

export function latex() {
  return StreamLanguage.define(latexMode);
}
