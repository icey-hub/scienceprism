import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
const source = await readFile(new URL('../../frontend/src/app/papers/translationRequests.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 } }).outputText;
const { createReaderTranslation } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const config = (revision=0) => ({ revision, providers: [], settings: { defaultProviderId:'google-web', targetLanguage:'ja', automatic:false, cache:{enabled:true,ttlMs:1800000,maxEntries:200},monthlyCharacterLimit:null }, usage:{usedCharacters:0} });
const selection = id => ({ id,text:`text ${id}`,page:1,attachmentId:'pdf',fileSha256:'a'.repeat(64),rects:[] });
function fixture() {
  const loads=[], saves=[], translations=[], clears=[], published=[];let ids=0;
  const commands={
    load(signal) { const call={signal,...deferred()};loads.push(call);return call.promise; },
    save(revision,patch,signal) { const call={revision,patch,signal,...deferred()};saves.push(call);return call.promise; },
    clear(signal) { const call={signal,...deferred()};clears.push(call);return call.promise; },
    translate(selection,provider,target,operationId,signal) { const call={selection,provider,target,operationId,signal,...deferred()};translations.push(call);return call.promise; }
  };
  const controller=createReaderTranslation(commands, value=>published.push(value),()=>`op-${++ids}`);controller.activate();
  return { controller,loads,saves,translations,clears,published, latest:()=>published.at(-1) };
}
async function ready(f) { const reading=f.controller.refresh();f.loads.at(-1).resolve(config());await reading; }
const result = call => ({ translation:{selectionId:call.selection.id,providerId:call.provider,targetLanguage:call.target,translatedText:'translated',translatedAt:'now',cached:false} });

test('reader uses persisted source/language and reuses a request identity after uncertain HTTP failure', async()=>{
 const f=fixture();await ready(f);f.controller.select(selection('one'));
 const first=f.controller.translate();assert.equal(f.translations[0].provider,'google-web');assert.equal(f.translations[0].target,'ja');
 f.translations[0].reject(new Error('network interrupted'));await first;
 const replay=f.controller.translate();assert.equal(f.translations[1].operationId,f.translations[0].operationId);
 f.translations[1].resolve(result(f.translations[1]));await replay;assert.equal(f.latest().result.translatedText,'translated');
});

test('a deliberately new request gets a new identity, while double activation never sends a second pending request',async()=>{
 const f=fixture();await ready(f);f.controller.select(selection('one'));
 const first=f.controller.translate();await f.controller.translate(true);assert.equal(f.translations.length,1);
 f.translations[0].reject(new Error(JSON.stringify({error:{code:'TRANSLATION_RESULT_UNAVAILABLE',message:'lost'}})));await first;
 assert.match(f.latest().error,/不会自动重复发送/);
 const fresh=f.controller.translate(true);assert.notEqual(f.translations[1].operationId,f.translations[0].operationId);
 f.translations[1].resolve(result(f.translations[1]));await fresh;
});

test('selection changes abort old work; late success/error cannot replace the new selection', async()=>{
 const f=fixture();await ready(f);f.controller.select(selection('one'));const old=f.controller.translate();
 f.controller.select(selection('two'));assert.equal(f.translations[0].signal.aborted,true);const current=f.controller.translate();
 f.translations[1].resolve(result(f.translations[1]));await current;f.translations[0].resolve(result(f.translations[0]));await old;
 assert.equal(f.latest().result.selectionId,'two');assert.equal(f.translations[1].operationId,'op-2');
});

test('late settings reads cannot erase a saved configuration, writes use actual revision and partial cache patch',async()=>{
 const f=fixture();await ready(f);const stale=f.controller.refresh();const save=f.controller.save({cache:{enabled:false}});
 assert.equal(f.loads[1].signal.aborted,true);assert.equal(f.saves[0].revision,0);assert.deepEqual(f.saves[0].patch,{cache:{enabled:false}});
 const saved=config(1);saved.settings.cache.enabled=false;f.saves[0].resolve(saved);await save;
 f.loads[1].resolve(config(0));await stale;assert.equal(f.latest().configuration.revision,1);assert.equal(f.latest().configuration.settings.cache.enabled,false);
});

test('a settings conflict is visible and cannot silently overwrite another window; explicit read supplies next revision',async()=>{
 const f=fixture();await ready(f);const saving=f.controller.save({automatic:true});
 await f.controller.save({targetLanguage:'en'});assert.equal(f.saves.length,1);
 f.saves[0].reject(new Error(JSON.stringify({error:{code:'TRANSLATION_SETTINGS_CONFLICT',message:'conflict'}})));await saving;
 assert.equal(f.latest().configuration.revision,0);assert.match(f.latest().error,/其他窗口/);
 const refresh=f.controller.refresh();f.loads.at(-1).resolve(config(2));await refresh;
 const retry=f.controller.save({automatic:true});assert.equal(f.saves[1].revision,2);f.saves[1].resolve(config(3));await retry;
});

test('cache clearing cancels pending translation and preserves the attempt identity instead of automatically sending again',async()=>{
 const f=fixture();await ready(f);f.controller.select(selection('one'));const running=f.controller.translate();const clearing=f.controller.clear();
 assert.equal(f.translations[0].signal.aborted,true);await f.controller.translate();assert.equal(f.translations.length,1);
 f.clears[0].resolve({clearedEntries:4,clearedResults:1});await clearing;assert.match(f.latest().notice,/4 条/);
 f.translations[0].resolve(result(f.translations[0]));await running;assert.equal(f.latest().result,null);
 const retry=f.controller.translate();assert.equal(f.translations[1].operationId,f.translations[0].operationId);f.translations[1].resolve(result(f.translations[1]));await retry;
});

test('disposed requests cannot publish to a reopened reader and no translation is allowed before settings load',async()=>{
 const f=fixture();f.controller.select(selection('one'));await f.controller.translate();assert.equal(f.translations.length,0);
 const load=f.controller.refresh();f.controller.dispose();f.controller.activate();const reopened=f.controller.refresh();
 f.loads[1].resolve(config(4));await reopened;f.loads[0].resolve(config(0));await load;assert.equal(f.latest().configuration.revision,4);
 const save=f.controller.save({automatic:true});f.controller.dispose();const count=f.published.length;f.saves[0].resolve(config(5));await save;assert.equal(f.published.length,count);
});

test('wrong selection/provider/language responses cannot be delivered as the selected translation',async()=>{
 for (const patch of [{selectionId:'wrong'},{providerId:'bing-web'},{targetLanguage:'en'}]) {
  const f=fixture();await ready(f);f.controller.select(selection('one'));const running=f.controller.translate();
  const response=result(f.translations[0]);Object.assign(response.translation,patch);f.translations[0].resolve(response);await running;assert.equal(f.latest().result,null);
 }
});
