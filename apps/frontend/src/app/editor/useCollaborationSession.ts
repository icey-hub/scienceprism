import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yCollab } from 'y-codemirror.next';
import { CollabProvider, type CollabStatus } from '../../collab/provider';
import { flushCollabFile } from '../../api/collaborationAdapter';
import { getFile } from '../../api/projectAdapter';
import { normalizeServerUrl, pickCollabColor } from './editorSettings';

type Options = {
  projectId: string;
  path: string;
  enabled: boolean;
  supported: boolean;
  server: string;
  token: string;
  name: string;
  viewRef: MutableRefObject<EditorView | null>;
  compartment: Compartment;
  prepare: () => void;
  onStatus: (message: string) => void;
};

/** Own one Y.js document, its connection, and the flush-before-save boundary. */
export function useCollaborationSession(options: Options) {
  const { projectId, path, enabled, supported, server, token, name, viewRef, compartment } = options;
  const { t } = useTranslation();
  const latest = useRef(options);
  latest.current = options;
  const activeRef = useRef(false);
  const sessionRef = useRef<{ doc: Y.Doc; text: Y.Text } | null>(null);
  const [status, setStatus] = useState<CollabStatus>('disconnected');
  const [peers, setPeers] = useState<{ id: number; name: string; color: string }[]>([]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!enabled || !projectId || !path || !supported) {
      activeRef.current = false;
      view.dispatch({ effects: compartment.reconfigure([]) });
      setStatus('disconnected');
      setPeers([]);
      if (enabled && path && !supported) latest.current.onStatus(t('协作暂不支持该文件类型。'));
      return;
    }
    latest.current.prepare();
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', { name, color: pickCollabColor(name) });
    const provider = new CollabProvider({
      serverUrl: normalizeServerUrl(server) || window.location.origin,
      token: token || undefined, projectId, filePath: path, doc, awareness,
      onStatus: setStatus,
      onError: (error) => latest.current.onStatus(t('协作连接失败: {{error}}', { error }))
    });
    sessionRef.current = { doc, text };
    view.dispatch({ effects: compartment.reconfigure(yCollab(text, awareness)) });
    activeRef.current = true;
    provider.connect();
    const updatePeers = () => {
      const next: typeof peers = [];
      awareness.getStates().forEach((state, id) => {
        const user = (state as { user?: { name?: string; color?: string } }).user;
        if (user) next.push({ id, name: user.name || `User-${id}`, color: user.color || '#b44a2f' });
      });
      setPeers(next);
    };
    awareness.on('update', updatePeers);
    updatePeers();
    return () => {
      activeRef.current = false;
      sessionRef.current = null;
      awareness.off('update', updatePeers);
      provider.disconnect();
      awareness.destroy();
      doc.destroy();
      if (viewRef.current === view) view.dispatch({ effects: compartment.reconfigure([]) });
      setPeers([]);
    };
  }, [projectId, path, enabled, supported, server, token, name, viewRef, compartment, t]);

  const flush = useCallback(async () => {
    if (!activeRef.current || !path) return null;
    const session = sessionRef.current;
    if (status !== 'connected') throw new Error(t('协作尚未连接，任务未启动。'));
    await flushCollabFile(projectId, path);
    const stored = await getFile(projectId, path);
    if (session !== sessionRef.current || stored.content !== viewRef.current?.state.doc.toString()) {
      throw new Error(t('协作文稿尚未保存，请稍后重试。'));
    }
    return stored;
  }, [projectId, path, status, viewRef, t]);

  const replace = useCallback((target: string, content: string) => {
    const session = sessionRef.current;
    if (!activeRef.current || !session || target !== path) return false;
    session.doc.transact(() => {
      session.text.delete(0, session.text.length);
      session.text.insert(0, content);
    });
    return true;
  }, [path]);

  return { activeRef, status, peers, flush, replace };
}
