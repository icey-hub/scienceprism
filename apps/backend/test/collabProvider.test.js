import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = await build({
  stdin: {
    contents: "export { CollabProvider } from './provider'; export * as Y from 'yjs'; export { Awareness } from 'y-protocols/awareness';",
    resolveDir: fileURLToPath(new URL('../../frontend/src/collab/', import.meta.url))
  },
  bundle: true, write: false, format: 'esm', platform: 'browser'
});
const { CollabProvider, Y, Awareness } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

function fixture(t) {
  const timers = new Map(), sockets = [], statuses = [];
  let timerId = 0;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.readyState = 3; }
    send() {}
  }
  const previousWindow = globalThis.window, previousSocket = globalThis.WebSocket;
  globalThis.window = {
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  globalThis.WebSocket = Socket;
  const doc = new Y.Doc(), awareness = new Awareness(doc);
  const provider = new CollabProvider({ serverUrl: 'http://localhost', projectId: 'p', filePath: 'main.tex', doc, awareness, onStatus: status => statuses.push(status) });
  t.after(() => {
    provider.disconnect(); awareness.destroy(); doc.destroy();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    globalThis.WebSocket = previousSocket;
  });
  return { provider, sockets, timers, statuses };
}

test('disconnect cancels queued reconnect and stale retry cannot open a socket', t => {
  const { provider, sockets, timers } = fixture(t);
  provider.connect();
  sockets[0].onclose();
  assert.equal(timers.size, 1);
  const retry = [...timers.values()][0];
  provider.disconnect();
  assert.equal(timers.size, 0);
  retry();
  assert.equal(sockets.length, 1);
});

test('retired socket events cannot change status after disconnect', t => {
  const { provider, sockets, statuses } = fixture(t);
  provider.connect();
  const lateOpen = sockets[0].onopen, lateClose = sockets[0].onclose;
  provider.disconnect();
  const previous = [...statuses];
  lateOpen(); lateClose();
  assert.deepEqual(statuses, previous);
});
