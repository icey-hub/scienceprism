import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';
import * as Y from 'yjs';

const cache = path.resolve('.cache/collab-initialization-test');
await mkdir(cache, { recursive: true });
process.env.SCIENCEPRISM_DATA_DIR = await mkdtemp(path.join(cache, 'run-'));
const { registerCollabRoutes } = await import('../src/routes/collab.js');
const { getOrCreateDoc } = await import('../src/services/collab/docStore.js');
let connect;
registerCollabRoutes({ post() {}, get(url, ...args) { if (url === '/api/collab') connect = args.at(-1); } });

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close(code) { this.closeCode = code; this.readyState = 3; this.emit('close'); }
}
async function fixture(t, id) {
  const root = path.join(process.env.SCIENCEPRISM_DATA_DIR, id);
  await mkdir(root);
  await writeFile(path.join(root, 'project.json'), JSON.stringify({id,name:id}));
  await writeFile(path.join(root, 'main.tex'), 'Initial document.');
  const socket = new Socket();
  t.after(async () => {
    const doc = await getOrCreateDoc({key: `${id}:main.tex`,absPath:path.join(root,'main.tex')});
    socket.close();
    clearTimeout(doc.cleanupTimer); clearTimeout(doc.flushTimer);
    doc.awareness.destroy(); doc.ydoc.destroy();
  });
  return { socket, request: {query:{projectId:id,file:'main.tex'}, ip:'127.0.0.1',headers:{}} };
}

test('sync request arriving during async project load receives full document', async t => {
  const {socket, request} = await fixture(t, 'early-sync');
  const client = new Y.Doc(); t.after(() => client.destroy());
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder,0); sync.writeSyncStep1(encoder,client);
  const initializing = connect({socket},request);
  socket.emit('message',Buffer.from(encoding.toUint8Array(encoder)));
  await initializing;
  for (const frame of socket.sent) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) === 0) sync.readSyncMessage(decoder,encoding.createEncoder(),client,null);
  }
  assert.equal(client.getText('content').toString(),'Initial document.');
  assert.equal(socket.listenerCount('message'),1,'only the active message handler remains');
});

test('initialization queue rejects excess frames without attaching the socket', async t => {
  const {socket,request} = await fixture(t,'overflow');
  const initializing=connect({socket},request);
  socket.emit('message',Buffer.alloc(1024 * 1024 + 1));
  await initializing;
  assert.equal(socket.closeCode,1009);
  assert.equal(socket.listenerCount('message'),0);
  const doc=await getOrCreateDoc({key:'overflow:main.tex'});
  assert.equal(doc.conns.size,0);
});

test('socket closed during initialization is not attached to document', async t => {
  const {socket,request} = await fixture(t,'early-close');
  const initializing=connect({socket},request);
  socket.close();
  await initializing;
  assert.equal(socket.listenerCount('message'),0);
  const doc=await getOrCreateDoc({key:'early-close:main.tex'});
  assert.equal(doc.conns.size,0);
});
