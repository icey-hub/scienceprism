import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranslationState } from '../src/services/translation/state.js';

async function fixture(t, options = {}) {
  const cache = fileURLToPath(new URL('../../../.cache/research-workbench-v2/reader/', import.meta.url));
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'translation-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const project of ['one', 'two']) await fs.mkdir(path.join(root, project));
  const config = { resolveProject: async id => {
    if (!['one', 'two'].includes(id)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    return path.join(root, id);
  }, now: () => Date.parse('2026-10-12T00:00:00Z'), ownerId: 'process-one', ...options };
  return { root, config, store: createTranslationState(config) };
}

test('translation settings persist with CAS, strict input and project isolation', async t => {
  const { root, config, store } = await fixture(t);
  const initial = await store.read('one');
  assert.equal(initial.settings.defaultProviderId, 'bing-web');
  assert.equal(initial.settings.targetLanguage, 'zh-CN');
  assert.equal(initial.settings.monthlyCharacterLimit, null);
  assert.equal(initial.usage.remainingCharacters, null);
  await assert.rejects(fs.stat(path.join(root, 'one', '.scienceprism')), { code: 'ENOENT' });
  const changed = await store.updateSettings('one', { expectedRevision: initial.revision,
    patch: { defaultProviderId: 'google-web', targetLanguage: 'ja', automatic: true, monthlyCharacterLimit: 10, cache: { enabled: false, ttlMs: 60000, maxEntries: 2 } } });
  assert.notEqual(changed.revision, initial.revision);
  assert.deepEqual((await createTranslationState(config).read('one')).settings, changed.settings);
  assert.equal((await store.read('two')).settings.defaultProviderId, 'bing-web');
  await assert.rejects(store.updateSettings('one', { expectedRevision: initial.revision, patch: { automatic: false } }), { code: 'TRANSLATION_SETTINGS_CONFLICT' });
  for (const patch of [{ defaultProviderId: 'azure-translator' }, { targetLanguage: 'auto' }, { monthlyCharacterLimit: -1 }, { cache: { enabled: 'yes' } }, { endpoint: 'https://example.com' }]) {
    await assert.rejects(store.updateSettings('one', { expectedRevision: changed.revision, patch }), { code: 'TRANSLATION_INVALID_INPUT' });
  }
  const toggled = await store.updateSettings('one', { expectedRevision: changed.revision, patch: { cache: { enabled: true } } });
  assert.deepEqual(toggled.settings.cache, { enabled: true, ttlMs: 60000, maxEntries: 2 });
  await assert.rejects(store.updateSettings('one', { expectedRevision: toggled.revision, patch: { cache: { secretKey: 'unsupported' } } }), { code: 'TRANSLATION_INVALID_INPUT' });
  await assert.rejects(store.read('../one'), { code: 'TRANSLATION_INVALID_INPUT' });
  await assert.rejects(store.read('missing'), { code: 'TRANSLATION_PROJECT_UNAVAILABLE' });
});

const request = (operationId, text = 'hello', extra = {}) => ({ operationId, providerId: 'bing-web', text, sourceLanguage: 'auto', targetLanguage: 'zh-CN', selectionId: 'selection', ...extra });

test('concurrent reservations respect one project budget and bind every semantic request field', async t => {
  const { store } = await fixture(t);
  await store.updateSettings('one', { expectedRevision: 0, patch: { monthlyCharacterLimit: 5 } });
  const inputs = [request('a'), request('b', 'world', { providerId: 'google-web' })];
  const results = await Promise.allSettled(inputs.map(input => store.reserve('one', input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'TRANSLATION_QUOTA_EXHAUSTED');
  // Async project resolution may admit either caller first; exactly one must win.
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const admitted = inputs[winner];
  const first = results[winner].value;
  assert.equal(first.disposition, 'reserved');
  assert.equal(first.operation.characters, 5);
  assert.equal(first.usage.reservedCharacters, 5);
  assert.equal(first.usage.remainingCharacters, 0);
  assert.equal((await store.reserve('one', admitted)).disposition, 'existing');
  assert.equal((await store.lookup('one', admitted)).operation.requestHash, first.operation.requestHash);
  for (const altered of [{ text: 'other' }, { providerId: admitted.providerId === 'bing-web' ? 'google-web' : 'bing-web' }, { selectionId: 'other' }, { targetLanguage: 'en' }, { sourceLanguage: 'en' },
    { source: { paperId: 'paper', attachmentId: 'pdf', fileSha256: 'a'.repeat(64), page: 1 } }]) {
    await assert.rejects(store.lookup('one', { ...admitted, ...altered }), { code: 'TRANSLATION_OPERATION_CONFLICT' });
  }
  assert.equal((await store.read('one')).revision, 1);
  assert.equal((await store.reserve('two', request('a'))).disposition, 'reserved');
  await store.markDispatched('one', admitted.operationId);
  await store.settle('one', admitted.operationId, { outcome: 'completed' });
  assert.equal((await store.read('one')).usage.usedCharacters, 5);
  assert.equal((await store.read('one')).usage.reservedCharacters, 0);
  assert.equal((await store.reserve('one', admitted)).operation.status, 'completed');
});

test('restart preserves uncertain reservations and all completed or released identities', async t => {
  const { store, config, root } = await fixture(t);
  const sameProcess = { ...config }; delete sameProcess.ownerId;
  await createTranslationState(sameProcess).reserve('two', request('default-owner'));
  assert.equal((await createTranslationState(sameProcess).lookup('two', request('default-owner'))).operation.status, 'reserved');
  await store.updateSettings('one', { expectedRevision: 0, patch: { monthlyCharacterLimit: 20 } });
  for (const operation of ['reserved', 'sent', 'done', 'released']) await store.reserve('one', request(operation));
  await store.markDispatched('one', 'sent');
  await store.markDispatched('one', 'done');
  await store.settle('one', 'done', { outcome: 'completed' });
  await store.settle('one', 'released', { outcome: 'released' });
  assert.equal((await createTranslationState(config).lookup('one', request('reserved'))).operation.status, 'reserved');
  const file = path.join(root, 'one', '.scienceprism', 'translation.json');
  const before = await fs.readFile(file, 'utf8');
  const restarted = createTranslationState({ ...config, ownerId: 'process-two' });
  assert.equal((await restarted.lookup('one', request('reserved'))).operation.status, 'uncertain');
  assert.equal((await restarted.lookup('one', request('sent'))).operation.status, 'uncertain');
  assert.equal((await restarted.read('one')).usage.uncertainCharacters, 10);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'read-only recovery projection does not mutate storage');
  for (const operation of ['reserved', 'sent', 'done', 'released']) {
    assert.equal((await restarted.reserve('one', request(operation))).disposition, 'existing');
    await assert.rejects(restarted.markDispatched('one', operation), { code: 'TRANSLATION_OPERATION_STATE' });
  }
  assert.equal((await restarted.lookup('one', request('done'))).operation.status, 'completed');
  assert.equal((await restarted.lookup('one', request('released'))).operation.status, 'released');
  const nextMonth = createTranslationState({ ...config, ownerId: 'process-two', now: () => Date.parse('2026-11-01T00:00:00Z') });
  assert.equal((await nextMonth.read('one')).usage.usedCharacters, 0);
  assert.equal((await nextMonth.read('one')).usage.reservedCharacters, 10, 'uncertain usage is not reset by a month rollover');
});

test('cache identities persist without charging and sent failures cannot refund or run twice', async t => {
  const { store, config, root } = await fixture(t);
  await store.updateSettings('one', { expectedRevision: 0, patch: { monthlyCharacterLimit: 1 } });
  const cached = await store.recordCached('one', request('cached', 'Secret selected text'));
  assert.equal(cached.operation.status, 'completed');
  assert.equal(cached.operation.cached, true);
  assert.equal(cached.usage.usedCharacters, 0);
  assert.equal(cached.usage.remainingCharacters, 1);
  assert.equal((await createTranslationState({ ...config, ownerId: 'restart' }).reserve('one', request('cached', 'Secret selected text'))).disposition, 'existing');
  assert.ok(!(await fs.readFile(path.join(root, 'one', '.scienceprism', 'translation.json'), 'utf8')).includes('Secret selected text'));
  await store.reserve('one', request('sent', '😀'));
  await assert.rejects(store.settle('one', 'sent', { outcome: 'completed' }), { code: 'TRANSLATION_OPERATION_STATE' });
  await store.markDispatched('one', 'sent');
  await assert.rejects(store.settle('one', 'sent', { outcome: 'released' }), { code: 'TRANSLATION_OPERATION_STATE' });
  await store.settle('one', 'sent', { outcome: 'uncertain' });
  await assert.rejects(store.markDispatched('one', 'sent'), { code: 'TRANSLATION_OPERATION_STATE' });
  await assert.rejects(store.reserve('one', request('new', 'a')), { code: 'TRANSLATION_QUOTA_EXHAUSTED' });
  assert.equal((await store.read('one')).usage.uncertainCharacters, 1);
});

test('full history rejects new work but retains every prior identity and settlement', async t => {
  const { store } = await fixture(t, { maxOperations: 2 });
  await store.reserve('one', request('active'));
  await store.recordCached('one', request('cache'));
  await assert.rejects(store.reserve('one', request('overflow')), { code: 'TRANSLATION_STATE_CAPACITY' });
  await assert.rejects(store.recordCached('one', request('overflow')), { code: 'TRANSLATION_STATE_CAPACITY' });
  await store.markDispatched('one', 'active');
  await store.settle('one', 'active', { outcome: 'completed' });
  assert.equal((await store.reserve('one', request('active'))).operation.status, 'completed');
  assert.equal((await store.read('one')).usage.operationCount, 2);
});

test('corrupt, oversized and linked state is refused without overwriting evidence', async t => {
  const { store, root, config } = await fixture(t);
  await store.reserve('one', request('valid'));
  const directory = path.join(root, 'one', '.scienceprism');
  const file = path.join(directory, 'translation.json');
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const invalid of ['{broken', JSON.stringify({ ...valid, schemaVersion: 2 }), JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, operations: [valid.operations[0], valid.operations[0]] }),
    JSON.stringify({ ...valid, operations: [{ ...valid.operations[0], characters: -1 }] })]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(store.reserve('one', request('blocked')), { code: 'TRANSLATION_STATE_INVALID' });
    assert.equal(await fs.readFile(file, 'utf8'), invalid);
  }
  await fs.writeFile(file, ' '.repeat(2049));
  await assert.rejects(createTranslationState({ ...config, maxStateBytes: 2048 }).read('one'), { code: 'TRANSLATION_STATE_CAPACITY' });
  await fs.rm(file);
  const target = path.join(root, 'two', 'untouched.json');
  const contents = JSON.stringify(valid);
  await fs.writeFile(target, contents);
  await fs.symlink(target, file);
  await assert.rejects(store.reserve('one', request('linked')), { code: 'TRANSLATION_STATE_INVALID' });
  assert.equal(await fs.readFile(target, 'utf8'), contents);
  await fs.rm(file);
  await fs.link(target, file);
  await assert.rejects(store.read('one'), { code: 'TRANSLATION_STATE_INVALID' });
  await fs.rm(directory, { recursive: true });
  await fs.symlink(path.join(root, 'two'), directory);
  await assert.rejects(store.updateSettings('one', { expectedRevision: 0, patch: { automatic: true } }), { code: 'TRANSLATION_STATE_INVALID' });
  await assert.rejects(fs.stat(path.join(root, 'two', 'translation.json')), { code: 'ENOENT' });
});

test('lowering the application limit stops reserved work before dispatch', async t => {
  const { store } = await fixture(t);
  await store.reserve('one', request('pending'));
  await store.updateSettings('one', { expectedRevision: 0, patch: { monthlyCharacterLimit: 4 } });
  await assert.rejects(store.markDispatched('one', 'pending'), { code: 'TRANSLATION_QUOTA_EXHAUSTED' });
  assert.equal((await store.lookup('one', request('pending'))).operation.status, 'reserved');
  await store.settle('one', 'pending', { outcome: 'released' });
  assert.equal((await store.read('one')).usage.remainingCharacters, 4);
});

test('bounded byte capacity fails atomically and leaves room to settle admitted work', async t => {
  const { store, root } = await fixture(t, { maxStateBytes: 1024 });
  const original = request('x'.repeat(160));
  await store.reserve('one', original);
  const file = path.join(root, 'one', '.scienceprism', 'translation.json');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(store.reserve('one', request('y'.repeat(160))), { code: 'TRANSLATION_STATE_CAPACITY' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await store.lookup('one', request('y'.repeat(160)))).operation, null);
  await store.markDispatched('one', original.operationId);
  await store.settle('one', original.operationId, { outcome: 'completed' });
  assert.equal((await store.read('one')).usage.usedCharacters, 5);
  assert.ok((await fs.stat(file)).size <= 1024);
});

test('request validation rejects forged accounting and normalizes only source identity syntax', async t => {
  const { store, root } = await fixture(t);
  for (const extra of [{ providerId: 'azure-translator' }, { charge: false }, { cached: true }, { characters: 0 }, { requestHash: 'a'.repeat(64) },
    { text: '   ' }, { text: '\ud800' }, { text: 'a'.repeat(1001) }, { sourceLanguage: 'xx' }, { targetLanguage: 'auto' },
    { source: { paperId: 'a', attachmentId: 'b', fileSha256: 'a'.repeat(64), page: 0 } }]) {
    await assert.rejects(store.reserve('one', request('invalid', 'hello', extra)), { code: 'TRANSLATION_INVALID_INPUT' });
  }
  await assert.rejects(fs.stat(path.join(root, 'one', '.scienceprism')), { code: 'ENOENT' });
  const source = { paperId: 'unverified-paper', attachmentId: 'unverified-attachment', fileSha256: 'a'.repeat(64), page: 3 };
  const original = request('unicode', 'a 😀 ', { source });
  const saved = await store.reserve('one', original);
  assert.equal(saved.operation.characters, 4, 'code points include both spaces');
  const reordered = { source: { page: 3, fileSha256: 'A'.repeat(64), attachmentId: source.attachmentId, paperId: source.paperId },
    selectionId: original.selectionId, targetLanguage: original.targetLanguage, sourceLanguage: original.sourceLanguage,
    text: original.text, providerId: original.providerId, operationId: original.operationId };
  assert.equal((await store.lookup('one', reordered)).operation.requestHash, saved.operation.requestHash);
  await assert.rejects(store.lookup('one', { ...original, source: { ...source, page: 4 } }), { code: 'TRANSLATION_OPERATION_CONFLICT' });
  await assert.rejects(store.lookup('one', { ...original, source: { ...source, fileSha256: 'b'.repeat(64) } }), { code: 'TRANSLATION_OPERATION_CONFLICT' });
});
