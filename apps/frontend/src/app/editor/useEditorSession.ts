import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

type SessionOptions = {
  extensions: () => Extension[];
  onChange: (value: string, programmatic: boolean) => void;
  onSelection: (value: string, head: number) => void;
  onUpdate: (update: ViewUpdate) => void;
  onCompletion: () => void;
};

/** Own the mounted view and its document/selection projection; drafts own persistence. */
export function useEditorSession(options: SessionOptions) {
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Research mode temporarily removes the host, but the document and history stay live.
  const hostRef = useCallback((node: HTMLDivElement | null) => {
    host.current = node;
    const view = viewRef.current;
    if (node && view) {
      node.appendChild(view.dom);
      view.requestMeasure();
    }
  }, []);
  const suppressDirtyRef = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const [value, setValue] = useState('');
  const [selection, setSelection] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const next = update.state.doc.toString();
        const programmatic = suppressDirtyRef.current;
        suppressDirtyRef.current = false;
        setValue(next);
        latest.current.onChange(next, programmatic);
      }
      if (update.selectionSet) {
        const { from, to, head } = update.state.selection.main;
        setSelection([from, to]);
        latest.current.onSelection(update.state.doc.toString(), head);
      }
      latest.current.onUpdate(update);
    });
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions: [...latest.current.extensions(), updateListener] }),
      parent: host.current || undefined
    });
    viewRef.current = view;
    const handleAltSlash = (event: KeyboardEvent) => {
      if (event.altKey && (event.key === '/' || event.key === '÷' || event.code === 'Slash')) {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onCompletion();
      }
    };
    view.dom.addEventListener('keydown', handleAltSlash, true);
    return () => {
      view.dom.removeEventListener('keydown', handleAltSlash, true);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  const replaceDocument = useCallback((next: string) => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === next) return;
    suppressDirtyRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  }, []);

  return { hostRef, viewRef, value, setValue, selection, replaceDocument, suppressDirtyRef };
}
