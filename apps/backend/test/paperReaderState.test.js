import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { papersShareIdentity } from '../src/services/researchSources/candidateIdentity.js';

async function frontendModule(name) {
  const source = await readFile(new URL(`../../frontend/src/app/papers/${name}.ts`, import.meta.url), 'utf8');
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { createAnnotationRequests } = await frontendModule('annotationRequests');
const { matchPaper, findUniquePaper } = await frontendModule('paperIdentity');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const state = (revision, notes = []) => ({ revision, annotations: notes });
function annotationFixture() {
  const loads = [], published = [];
  const requests = createAnnotationRequests(signal => {
    const call = { ...deferred(), signal }; loads.push(call); return call.promise;
  }, value => published.push(value));
  requests.activate();
  return { requests, loads, published };
}
async function initial(fixture) {
  const reading = fixture.requests.refresh(); fixture.loads[0].resolve(state('R1')); await reading;
}

test('a delayed GET cannot erase a successfully saved annotation or restore its stale revision', async () => {
  const fixture = annotationFixture(); await initial(fixture);
  const staleGet = fixture.requests.refresh();
  const saving = deferred();
  const write = fixture.requests.change(revision => { assert.equal(revision, 'R1'); return saving.promise; });
  assert.equal(fixture.loads[1].signal.aborted, true);
  saving.resolve(state('R2', ['saved annotation'])); await write;
  fixture.loads[1].resolve(state('R1')); await staleGet;
  assert.deepEqual(fixture.published.at(-1), state('R2', ['saved annotation']));
  await fixture.requests.change(async revision => { assert.equal(revision, 'R2'); return state('R3', ['saved annotation', 'next note']); });
  assert.equal(fixture.published.at(-1).revision, 'R3');
});

test('refresh during mutation waits for the commit and then loads a fresh snapshot', async () => {
  const fixture = annotationFixture(); await initial(fixture);
  const saving = deferred();
  const write = fixture.requests.change(() => saving.promise);
  const refresh = fixture.requests.refresh();
  assert.equal(fixture.loads.length, 1);
  saving.resolve(state('R2', ['committed'])); await write;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.loads.length, 2);
  assert.equal(fixture.published.at(-1).revision, 'R2');
  fixture.loads[1].resolve(state('R3', ['committed', 'other tab'])); await refresh;
  assert.deepEqual(fixture.published.at(-1), state('R3', ['committed', 'other tab']));
});

test('newer refresh wins; stale errors and disposed requests cannot replace current state', async () => {
  const fixture = annotationFixture();
  const old = fixture.requests.refresh(), latest = fixture.requests.refresh();
  fixture.loads[1].resolve(state('R2')); await latest;
  fixture.loads[0].reject(new Error('late network error')); await old;
  assert.deepEqual(fixture.published, [state('R2')]);
  const stale = fixture.requests.refresh(); fixture.requests.dispose(); fixture.requests.activate();
  const reopened = fixture.requests.refresh(); fixture.loads[3].resolve(state('R4')); await reopened;
  fixture.loads[2].resolve(state('R3')); await stale;
  assert.equal(fixture.published.at(-1).revision, 'R4');
});

test('conflicts remain visible, concurrent writes are rejected and refresh enables an explicit retry', async () => {
  const fixture = annotationFixture(); await initial(fixture);
  const saving = deferred(); const write = fixture.requests.change(() => saving.promise);
  let calls = 0;
  await assert.rejects(fixture.requests.change(async () => { calls++; return state('bad'); }), /正在读取或保存/);
  assert.equal(calls, 0);
  saving.reject(new Error('ANNOTATION_REVISION_CONFLICT'));
  await assert.rejects(write, /ANNOTATION_REVISION_CONFLICT/);
  assert.equal(fixture.published.at(-1).revision, 'R1');
  const refresh = fixture.requests.refresh(); fixture.loads[1].resolve(state('R2', ['human note'])); await refresh;
  await fixture.requests.change(async revision => { assert.equal(revision, 'R2'); return state('R3', ['human note', 'retry']); });
  assert.deepEqual(fixture.published.at(-1).annotations, ['human note', 'retry']);
});

test('unmount rejects new saves and ignores completion of an already-sent save', async () => {
  const fixture = annotationFixture(); await initial(fixture);
  const saving = deferred(); const write = fixture.requests.change(() => saving.promise);
  fixture.requests.dispose(); saving.resolve(state('R2')); await write;
  assert.equal(fixture.published.at(-1).revision, 'R1');
  await assert.rejects(fixture.requests.change(async () => state('R3')), /正在读取或保存/);
});

test('frontend identity agrees with backend on strong conflicts, normalized identifiers and URL evidence', () => {
  const examples = [
    [{ doi: '10.1000/old', arxivId: '1706.03762' }, { doi: '10.1000/new', arxivId: '1706.03762v2' }, false],
    [{ doi: '10.1000/old', url: 'https://example.org/paper' }, { doi: '10.1000/new', url: 'https://example.org/paper' }, false],
    [{ doi: '10.1000/same', arxivId: '1706.03762' }, { doi: '10.1000/same', arxivId: '1234.56789' }, false],
    [{ doi: 'https://doi.org/10.1000/TEST' }, { doi: ' doi:10.1000/test ' }, true],
    [{ arxivId: 'arXiv:1706.03762v1' }, { url: 'https://arxiv.org/pdf/1706.03762v2.pdf' }, true],
    [{ url: 'https://example.org/paper/#read' }, { url: 'https://example.org/paper' }, true],
    [{ url: 'javascript:alert(1)' }, { url: 'javascript:alert(1)' }, false],
    [{ url: 'https://user:password@example.org/paper' }, { url: 'https://user:password@example.org/paper' }, false],
    [{ title: 'Same title' }, { title: 'Same title' }, false]
  ];
  for (const [left, right, expected] of examples) {
    assert.equal(matchPaper(left, right), expected, JSON.stringify([left, right]));
    assert.equal(matchPaper(left, right), papersShareIdentity(left, right));
  }
});

test('ambiguous library matches return no selected paper regardless of order', () => {
  const papers = [{ id: 'one', doi: '10.1000/one', arxivId: '1706.03762' }, { id: 'two', doi: '10.1000/two', arxivId: '1706.03762v2' }];
  assert.equal(findUniquePaper(papers, { arxivId: '1706.03762' }), undefined);
  assert.equal(findUniquePaper([...papers].reverse(), { arxivId: '1706.03762' }), undefined);
  assert.equal(findUniquePaper(papers, { doi: '10.1000/two', arxivId: '1706.03762' }), papers[1]);
  assert.equal(findUniquePaper(papers, { doi: '10.1000/other' }), undefined);
});
