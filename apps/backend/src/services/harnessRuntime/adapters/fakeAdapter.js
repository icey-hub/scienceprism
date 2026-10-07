import { readFileState } from '../fileVersions.js';

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error('Fake Harness run aborted.'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export const fakeHarnessAdapter = Object.freeze({
  id: 'fake',
  label: 'Fake Harness Adapter',
  async run({ request, projectRoot, signal, emit }) {
    const patches = await Promise.all((Array.isArray(request.fakePatches) ? request.fakePatches : []).map(async (patch) => {
      const state = await readFileState(projectRoot, patch.path);
      return { ...patch, original: state.content, baseVersion: { exists: state.exists, sha256: state.sha256 } };
    }));
    await sleep(Number(request.fakeDelayMs) || 0, signal);
    if (request.fakeError) {
      const error = new Error(String(request.fakeError));
      error.code = 'FAKE_FAILURE';
      throw error;
    }
    emit({ type: 'adapter/started', data: { adapter: 'fake' } });
    const response = request.fakeResponse === undefined
      ? JSON.stringify({ ok: true, adapter: 'fake' })
      : String(request.fakeResponse);
    emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: response }] } } });
    emit({ type: 'turn/end', data: { reason: { kind: 'stop' } } });
    return { finalResponse: response, events: [], sessionId: `fake-${Date.now()}`, patches };
  }
});
