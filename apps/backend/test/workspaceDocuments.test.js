import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
const source=await readFile(new URL('../../frontend/src/app/workspace/projectDocuments.ts',import.meta.url),'utf8');
const compiled=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2020}}).outputText;
const {updateProjectDocument,mergeBibEntries}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('standalone tool writes carry the exact fresh file version and preserve existing content',async()=>{
 const version={exists:true,sha256:'before'},writes=[];
 const read=async path=>{assert.equal(path,'references.bib');return {content:'% Existing\n@article{old, title={Old}}\n',version};};
 const write=async(path,content,expected)=>{assert.equal(expected,version);writes.push({path,content});};
 await updateProjectDocument(read,write,'references.bib',content=>mergeBibEntries(content,['@article{new, title={New}}']).content);
 assert.equal(writes.length,1);assert.match(writes[0].content,/^% Existing\n@article\{old/);assert.match(writes[0].content,/@article\{new/);
});
test('a concurrent document change aborts the standalone insertion without retrying over newer content',async()=>{
 let stored='old',revision=1,writes=0;
 const read=async()=>{const snapshot={content:stored,version:{exists:true,sha256:String(revision)}};stored='human edit';revision++;return snapshot;};
 const write=async(_path,content,expected)=>{writes++;if(expected?.sha256!==String(revision))throw new Error('FILE_VERSION_CONFLICT');stored=content;};
 await assert.rejects(updateProjectDocument(read,write,'main.tex',content=>content+'\nNew result'),/FILE_VERSION_CONFLICT/);
 assert.equal(stored,'human edit');assert.equal(writes,1);
});
test('bibliography merging handles literal keys, repeated entries and existing empty files without rewriting duplicates',async()=>{
 const existing='@article{key+1, title={Keep human metadata}}\n';
 const result=mergeBibEntries(existing,['@article{key+1, title={Model rewrite}}','@article{new, title={Added}}','@article{new, title={Duplicate}}']);
 assert.deepEqual(result.keys,['key+1','new']);assert.match(result.content,/Keep human metadata/);assert.doesNotMatch(result.content,/Model rewrite|Duplicate/);assert.equal((result.content.match(/@article\{new/g)||[]).length,1);
 let writes=0;await updateProjectDocument(async()=>({content:existing,version:{exists:true,sha256:'same'}}),async()=>writes++,'references.bib',content=>mergeBibEntries(content,['@article{key+1, title={Do not replace}}']).content);assert.equal(writes,0);
 assert.throws(()=>mergeBibEntries('', ['broken model output']),/BibTeX/);
});
