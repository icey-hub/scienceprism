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
 const existing='@article{key+1,\n  title = {Keep human metadata}\n}\n';
 const identical='@article{key+1,title={Keep human metadata}}';
 const result=mergeBibEntries(existing,[identical,'@article{new, title={Added}}','@article{new, title={Added}}']);
 assert.deepEqual(result.keys,['key+1','new']);assert.ok(result.content.startsWith(existing));assert.equal((result.content.match(/@article\{new/g)||[]).length,1);
 let writes=0;await updateProjectDocument(async()=>({content:existing,version:{exists:true,sha256:'same'}}),async()=>writes++,'references.bib',content=>mergeBibEntries(content,[identical]).content);assert.equal(writes,0);
 assert.throws(()=>mergeBibEntries('', ['broken model output']),/BibTeX/);
});

test('same citation key with another DOI or metadata aborts before any file write',async()=>{
 const existing='@article{smith2024, title={Human title}, doi={10.1000/old}}\n';
 let writes=0;
 for(const incoming of [
  '@article{smith2024, title={Another paper}, doi={10.1000/new}}',
  '@article{smith2024, title={Model changed metadata}, doi={10.1000/old}}',
  '@article{smith2024, title={Human title}, doi={10.1000/old}, author={Added author}}'
 ]) await assert.rejects(updateProjectDocument(async()=>({content:existing,version:{exists:true,sha256:'same'}}),async()=>writes++,'references.bib',content=>mergeBibEntries(content,[incoming]).content),/引用键.*smith2024.*不同/);
 assert.equal(writes,0);
 assert.throws(()=>mergeBibEntries('', ['@article{new,title={First}}','@article{new,title={Second}}']),/引用键.*不同/);
 assert.throws(()=>mergeBibEntries(existing+existing.replace('Human title','Conflicting duplicate'),[existing.trim()]),/引用键.*不同/);
});

test('full-entry comparison respects nested braces, quotes, comments, TeX commands and word boundaries',()=>{
 const entries=[
  String.raw`@article{tex, title={A {Nested} title with \nu and \newcommand{\name}{value}}}`,
  '@article{quoted,title="Quoted {value} with @ inside"}',
  '@book(paren,title={Parenthesized entry})',
  '@article{nested,title={Literal @article{fake, title={Text}}}}'
 ];
 const existing='% @article{tex, title={Only a comment}}\n@comment{An unmatched " is comment text}\n'+entries.join('\n')+'\n';
 const result=mergeBibEntries(existing,entries);
 assert.equal(result.content,existing);
 assert.match(mergeBibEntries('',[entries[0]]).content,/\\nu and \\newcommand/);
 assert.throws(()=>mergeBibEntries('@article{key,title={New York}}',['@article{key,title={NewYork}}']),/引用键.*不同/);
 assert.throws(()=>mergeBibEntries('@article{broken,title={Missing close}',['@article{new,title={Fine}}']),/未闭合/);
 assert.throws(()=>mergeBibEntries('', ['@article{one,title={One}} @article{two,title={Two}}']),/一条完整/);
});
