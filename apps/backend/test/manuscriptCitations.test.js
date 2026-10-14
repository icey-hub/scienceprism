import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const data=await fs.mkdtemp(path.join(os.tmpdir(),'citation-command-'));
process.env.SCIENCEPRISM_DATA_DIR=data;
const {importPaper}=await import('../src/services/projectHub/paperLibrary.js');
const {fileVersion}=await import('../src/services/harnessRuntime/fileVersions.js');
const {previewManuscriptCitation,applyManuscriptCitation,getManuscriptCitationRequest}=await import('../src/services/projectHub/manuscriptCitations.js');
const {writeFileTransaction,rollbackFileTransaction}=await import('../src/services/harnessRuntime/fileTransactions.js');
after(()=>fs.rm(data,{recursive:true,force:true}));
const tex='\\documentclass{article}\n\\begin{document}\n原稿 😀\n\\bibliography{refs}\n\\end{document}\n';
async function fixture(id,content=tex,bib='% preserved comment\n') {
 const root=path.join(data,id);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id,name:id}));await fs.writeFile(path.join(root,'main.tex'),content);await fs.writeFile(path.join(root,'refs.bib'),bib);
 const {paper}=await importPaper(id,{title:'Actual source',authors:['Author'],doi:'10.1234/source',bibtex:'@article{source,title={Actual source},author={Author},doi={10.1234/source}}'});
 const input={paperId:paper.id,texPath:'main.tex',bibPath:'refs.bib',expectedTexVersion:fileVersion(content),expectedBibVersion:fileVersion(bib),position:{offset:content.indexOf('原稿')+2}};
 return {root,paper,input};
}
const options={actor:'human'};
test('one command saves exact citation, Bib and source; same id returns original receipt without duplicate',async()=>{
 const {root,input}=await fixture('atomic');const preview=await previewManuscriptCitation('atomic',input,options);assert.equal(preview.bibliographyLinked,true);
 const command={...input,requestId:'same-request',expectedPaperRevision:preview.source.paperRevision};const saved=await applyManuscriptCitation('atomic',command,options);
 const content=await fs.readFile(path.join(root,'main.tex'),'utf8');assert.equal(content.slice(saved.tex.from,saved.tex.to),'\\cite{source}');assert.ok((await fs.readFile(path.join(root,'refs.bib'),'utf8')).startsWith('% preserved comment\n'));
 assert.equal(saved.source.verificationStatus,'unverified');assert.deepEqual(await applyManuscriptCitation('atomic',command,options),saved);
 assert.deepEqual((await getManuscriptCitationRequest('atomic','same-request')).receipt,saved);
 await assert.rejects(applyManuscriptCitation('atomic',{...command,citationKey:'other'},options),error=>error.code==='CITATION_REQUEST_MISMATCH');
});
test('second-file failure restores first file and preserves one recoverable request',async(t)=>{
 const {root,input}=await fixture('rollback');const preview=await previewManuscriptCitation('rollback',input,options),originalRename=fs.rename;let failed=false;
 const replacement=t.mock.method(fs,'rename',async(from,to)=>{if(to===path.join(root,'refs.bib')&&!failed){failed=true;throw Object.assign(new Error('disk failed'),{code:'EIO'});}return originalRename(from,to);});
 const command={...input,requestId:'write-failure',expectedPaperRevision:preview.source.paperRevision};
 await assert.rejects(applyManuscriptCitation('rollback',command,options),error=>error.code==='CITATION_APPLICATION_FAILED');replacement.mock.restore();
 assert.equal(await fs.readFile(path.join(root,'main.tex'),'utf8'),tex);assert.equal(await fs.readFile(path.join(root,'refs.bib'),'utf8'),'% preserved comment\n');assert.equal((await getManuscriptCitationRequest('rollback','write-failure')).status,'rolled_back');
 await assert.rejects(applyManuscriptCitation('rollback',command,options),error=>error.code==='CITATION_ROLLED_BACK');
});
test('new Bib plus explicit import is previewed and committed; import offsets keep exact citation range',async()=>{
 const content=tex.replace('\\bibliography{refs}\n',''),{root,input}=await fixture('import',content);
 input.bibPath='new.bib';input.expectedBibVersion=fileVersion(null);
 const unlinked=await previewManuscriptCitation('import',input,options);assert.equal(unlinked.bibliographyLinked,false);
 await assert.rejects(applyManuscriptCitation('import',{...input,requestId:'no-import',expectedPaperRevision:unlinked.source.paperRevision},options),error=>error.code==='CITATION_BIB_UNLINKED');
 const linkedInput={...input,bibliographyImport:{kind:'biblatex',offset:content.indexOf('\\begin{document}')}};
 const preview=await previewManuscriptCitation('import',linkedInput,options);assert.match(preview.importPreview.text,/addbibresource\{new.bib\}/);
 const receipt=await applyManuscriptCitation('import',{...linkedInput,requestId:'with-import',expectedPaperRevision:preview.source.paperRevision},options),saved=await fs.readFile(path.join(root,'main.tex'),'utf8');
 assert.equal(saved,preview.texPreview);assert.equal(saved.slice(receipt.tex.from,receipt.tex.to),'\\cite{source}');assert.equal(receipt.tex.line,saved.slice(0,receipt.tex.from).split('\n').length);assert.match(await fs.readFile(path.join(root,'new.bib'),'utf8'),/@article\{source/);
});
test('changed papers, conflicting Bib, unsafe paths, invalid UTF8 and wrong PDF provenance do not write',async()=>{
 const {root,input}=await fixture('guards'),preview=await previewManuscriptCitation('guards',input,options);
 await assert.rejects(applyManuscriptCitation('guards',{...input,requestId:'wrong-paper',expectedPaperRevision:'0'.repeat(64)},options),error=>error.code==='CITATION_PAPER_CHANGED');
 await assert.rejects(previewManuscriptCitation('guards',{...input,texPath:'.scienceprism/secret.tex'},options),error=>error.code==='CITATION_PATH_INVALID');
 const conflicting='@article{source,title={Another paper}}';await fs.writeFile(path.join(root,'refs.bib'),conflicting);
 await assert.rejects(previewManuscriptCitation('guards',{...input,expectedBibVersion:fileVersion(conflicting)},options),error=>error.code==='CITATION_BIB_CONFLICT');
 await fs.writeFile(path.join(root,'refs.bib'),Buffer.from([0xff]));await assert.rejects(previewManuscriptCitation('guards',input,options),error=>error.code==='CITATION_UTF8_INVALID');assert.deepEqual(await fs.readFile(path.join(root,'refs.bib')),Buffer.from([0xff]));
 await fs.writeFile(path.join(root,'refs.bib'),'% preserved comment\n');
 await assert.rejects(previewManuscriptCitation('guards',{...input,readingSource:{attachmentId:'missing',sha256:'a'.repeat(64),page:1}},options));
 assert.equal(await fs.readFile(path.join(root,'main.tex'),'utf8'),tex);assert.ok(preview.source.paperRevision);
});
test('shared file rollback preserves newer content and reports recovery; pure multi-file writers detect CAS',async()=>{
 const {root}=await fixture('shared');const entries=[{path:'main.tex',before:{...fileVersion(tex),content:tex},after:{...fileVersion('applied'),content:'applied'}}];
 await writeFileTransaction({root,projectId:'shared',entries});await fs.writeFile(path.join(root,'main.tex'),'user newer draft');const transaction={entries,status:'applying'};
 const conflicts=await rollbackFileTransaction(root,transaction,'shared');assert.equal(transaction.status,'recovery_required');assert.equal(conflicts[0].reason,'changed_since_application');assert.equal(await fs.readFile(path.join(root,'main.tex'),'utf8'),'user newer draft');
 await assert.rejects(writeFileTransaction({root,projectId:'shared',entries}),error=>error.code==='PATCH_VERSION_CONFLICT');
});

test('complete lexical entries preserve macros, parenthesized values and literal percent; nested TeX uses project-root Bib imports',async()=>{
 const {parseCitationBib,bibliographyLinked,citationTexMask}=await import('../src/services/projectHub/manuscriptCitationBib.js');
 const raw='@article(k,title={Effect of x) on y},journal=j)';
 const standalone=parseCitationBib(raw)[0];const contextual=parseCitationBib('@string{j={Nature}}\n'+raw)[0];
 assert.equal(standalone.fingerprint,contextual.fingerprint);
 assert.doesNotThrow(()=>citationTexMask('\\newcommand{\\word}{A literal " quote}'));
 assert.notEqual(parseCitationBib('@article{k,title={x%one}}')[0].fingerprint,parseCitationBib('@article{k,title={x%two}}')[0].fingerprint);
 assert.equal(bibliographyLinked('chapters/main.tex','refs.bib','\\bibliography{refs}'),true);
 assert.equal(bibliographyLinked('chapters/main.tex','refs.bib','\\bibliography{../refs}'),false);
});
