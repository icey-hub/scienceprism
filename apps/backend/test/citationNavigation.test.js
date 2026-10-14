import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../../frontend/src/app/editor/editorLocation.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { citationNavigationRange } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
test('citation links locate only the exact clean saved range, retaining changed drafts', () => {
  const sha256 = 'a'.repeat(64), content = '中文 😀 \\cite{real}';
  const version = { exists: true, sha256 };
  const params = new URLSearchParams({version: sha256, from: '6', to: String(content.length)});
  assert.deepEqual(citationNavigationRange(params, content, version, false), {from:6,to:content.length});
  assert.throws(() => citationNavigationRange(params, content, version, true), /未保存/);
  assert.throws(() => citationNavigationRange(params, content, {...version,sha256:'b'.repeat(64)}, false), /已变化/);
  for (const [field,value] of [['version',''],['from','-1'],['from','1e1'],['to','100'],['to','6']]) {
    const invalid = new URLSearchParams(params); invalid.set(field,value);
    assert.throws(() => citationNavigationRange(invalid, content, version, false));
  }
  assert.equal(citationNavigationRange(new URLSearchParams({line:'4'}),content,version,true),null);
});
