import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [new URL('../../frontend/src/app/editor/compileDiagnostics.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const diagnostics = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
test('unattributed TeX errors never inherit the main or previous diagnostic file', () => {
  const log = '(./main.tex\n(./section.tex\n! Undefined control sequence.\nl.3 \\badcommand';
  const errors = diagnostics.parseCompileErrors(log, 'main.tex');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, undefined);
  assert.equal(errors[0].line, undefined);
  const mixed = diagnostics.parseCompileErrors('section.tex:3: First error\n! Second error\nl.8 text', 'main.tex');
  assert.equal(mixed[0].file, 'section.tex');
  assert.equal(mixed[1].file, undefined);
  assert.equal(mixed[1].line, undefined);
});

test('diagnostic paths require exact relative identity, not a unique basename or suffix', () => {
  const paths = ['main.tex', 'chapters/section.tex', '文稿/one two.tex'];
  for (const file of ['/system/tex/main.tex', 'C:\\tex\\main.tex', '\\\\server\\main.tex', '../main.tex', 'chapters/../main.tex', 'section.tex', 'other/main.tex', 'https://host/main.tex', 'main.tex\0']) {
    assert.equal(diagnostics.resolveCompileFile(file, paths), undefined, file);
  }
  assert.equal(diagnostics.resolveCompileFile('./main.tex', paths), 'main.tex');
  assert.equal(diagnostics.resolveCompileFile('chapters\\section.tex', paths), 'chapters/section.tex');
  assert.equal(diagnostics.resolveCompileFile('文稿/one two.tex', paths), '文稿/one two.tex');
  assert.equal(diagnostics.resolveCompileFile('section.tex', ['a/section.tex', 'b/section.tex']), undefined);
});

test('explicit locations retain file identity and only valid lines become markers', () => {
  const errors = diagnostics.parseCompileErrors('error: chapters/section.tex:2: Undefined control sequence.\nchapters/section.tex:2: Undefined control sequence.\nwarning: main.tex:1: warning\nnote: main.tex:1: note', 'main.tex');
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], { file: 'chapters/section.tex', line: 2, message: 'Undefined control sequence.' });
  for (const line of [-1, 0, 1.5, Infinity, 4]) {
    assert.deepEqual(diagnostics.compileDiagnostics([{ file: 'main.tex', line, message: 'bad' }], 'main.tex', 'a\nb'), []);
  }
  assert.deepEqual(diagnostics.compileDiagnostics(errors, 'chapters/section.tex', 'first\n\\bad'), [{ from: 6, to: 10, severity: 'error', message: 'Undefined control sequence.' }]);
});

function entry(path, text) {
  return { path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}

test('compile diagnostics only bind UTF-8 text to the actual server input bytes', async () => {
  const text = '中文 😀\r\n\\badcommand';
  const manifest = { files: [entry('main.tex', text), entry('section.tex', 'old')] };
  assert.equal(await diagnostics.matchesCompileInput(manifest, 'main.tex', text), true);
  assert.equal(await diagnostics.matchesCompileInput(manifest, 'main.tex', text.replace('\r\n', '\n')), false);
  assert.equal(await diagnostics.matchesCompileInput(manifest, 'section.tex', 'new'), false);
  assert.equal(await diagnostics.matchesCompileInput(manifest, 'absent.tex', text), false);
  assert.equal(await diagnostics.matchesCompileInput(undefined, 'main.tex', text), false);
  assert.equal(await diagnostics.matchesCompileInput({ files: [{ ...entry('main.tex', text), bytes: text.length }] }, 'main.tex', text), false);
});

test('missing or failed browser crypto leaves diagnostic input unverified', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const value of [undefined, { subtle: { digest: async () => { throw Error('unavailable'); } } }]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
      assert.equal(await diagnostics.matchesCompileInput({ files: [entry('main.tex', 'source')] }, 'main.tex', 'source'), false);
    }
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});
