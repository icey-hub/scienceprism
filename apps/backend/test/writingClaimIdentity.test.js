import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
const cache=new URL('../../../.cache/writing-claim-test/',import.meta.url).pathname;
await mkdir(cache,{recursive:true});const dataDir=await mkdtemp(path.join(cache,'data-'));
process.env.SCIENCEPRISM_DATA_DIR=dataDir;process.env.TMPDIR=dataDir;process.env.NODE_ENV='test';
const {claimRows}=await import('../src/services/evidenceLedger/index.js');
const {normalizeEvidenceRecord,evidenceMaterialFingerprint}=await import('../src/services/evidenceLedger/schema.js');
const {registerEvidenceLedgerRoutes}=await import('../src/routes/evidenceLedger.js');
const {createWorkflowDocument}=await import('../src/services/researchWorkflow/stateMachine.js');
const {writingClaimEvidenceId}=await import('../src/services/researchWorkflow/writingClaims.js');
const {createHash}=await import('node:crypto');
test.after(()=>rm(dataDir,{recursive:true,force:true}));
async function files(root){const result={};for(const entry of await readdir(root,{withFileTypes:true})){const target=path.join(root,entry.name);if(entry.isDirectory())for(const [file,value] of Object.entries(await files(target)))result[`${entry.name}/${file}`]=value;else result[entry.name]=await readFile(target,'utf8');}return result;}

test('historical matrix aliases only exact generated claim sources, preserves human owners and performs no migration or model write',async()=>{
  const projectId='writing-claim-identity',root=path.join(dataDir,projectId),legacy=path.join(root,'.openprism');await mkdir(legacy,{recursive:true});await mkdir(path.join(root,'.scienceprism'));
  await writeFile(path.join(root,'project.json'),JSON.stringify({id:projectId}));
  const now='2026-10-14T00:00:00Z',paper=normalizeEvidenceRecord({id:'paper-a',kind:'paper',title:'Source A',version:'v1',verificationStatus:'human-confirmed'},{now});
  const claims=[0,1,2].map(index=>({id:`claim-frozen-${index}`,text:`Frozen conclusion ${index}`,evidenceIds:['paper-a'],evidenceVersions:{'paper-a':'v1'},confidence:0.2}));
  const entries=claims.map(claim=>normalizeEvidenceRecord({id:writingClaimEvidenceId(claim.id),kind:'paper-claim',title:claim.id,summary:claim.text,metadata:{evidenceIds:claim.evidenceIds,confidence:claim.confidence},evidenceVersions:claim.evidenceVersions,verificationStatus:'human-confirmed',citations:[{evidenceId:'paper-a',sourceVersion:'v1',excerpt:'Human checked original source',section:'Results',page:'3',locator:'',materialFingerprint:evidenceMaterialFingerprint(paper),sourceSnapshot:paper.source,actor:'human',recordedAt:now}]},{now}));
  assert.equal(entries[0].id,`claim-${createHash('sha1').update(claims[0].id).digest('hex').slice(0,20)}`);
  const otherPaper=normalizeEvidenceRecord({id:'paper-b',kind:'paper',title:'Independent valid Source B',version:'v1',verificationStatus:'human-confirmed'},{now});
  const ledger={schemaVersion:1,projectId,version:2,entries:[paper,otherPaper,...entries],relations:[],updatedAt:now},workflow=createWorkflowDocument(projectId);workflow.stages.find(stage=>stage.id==='writing').data={claims,task:{output:{claims:structuredClone(claims)}}};
  await writeFile(path.join(legacy,'research-workflow.json'),JSON.stringify(workflow));await writeFile(path.join(legacy,'evidence-ledger.json'),JSON.stringify(ledger));
  await writeFile(path.join(root,'.scienceprism','harness-runs.json'),JSON.stringify({schemaVersion:1,projectId,runs:[{id:'original-writer',reply:JSON.stringify({claims}),outputValidation:{data:{claims}}}]}));
  await writeFile(path.join(root,'writing-brief.md'),'Original brief remains unchanged');const before=await files(root);
  const app=Fastify();registerEvidenceLedgerRoutes(app);
  try{for(let attempt=0;attempt<2;attempt++){const response=await app.inject({method:'GET',url:`/api/projects/${projectId}/evidence/claims/matrix`});assert.equal(response.statusCode,200);const matrix=response.json().matrix;assert.equal(matrix.totalClaims,3);assert.deepEqual(matrix.rows.map(row=>row.id),entries.map(entry=>entry.id));assert.ok(matrix.rows.every(row=>row.status==='supported'));assert.deepEqual(matrix.rows[0].citations,entries[0].citations);}}
  finally{await app.close();}
  assert.deepEqual(await files(root),before,'GET must not migrate legacy stores, change Brief or edit the original Harness output');
  const modelRows=claimRows(ledger,workflow);assert.equal(modelRows[0].source,'ledger');assert.equal(modelRows[0].verificationStatus,'human-confirmed');
  for(const change of ['text','source','version','title']){
    const changedWorkflow=structuredClone(workflow),changedLedger=structuredClone(ledger),claim=changedWorkflow.stages.find(stage=>stage.id==='writing').data.claims[0];
    if(change==='text')claim.text='Different conclusion using the same model id';if(change==='source'){claim.evidenceIds=['paper-b'];claim.evidenceVersions={'paper-b':'v1'};}if(change==='version')claim.evidenceVersions['paper-a']='v2';if(change==='title')changedLedger.entries.find(entry=>entry.id===entries[0].id).title='Independent human record';
    assert.equal(claimRows(changedLedger,changedWorkflow).length,4,`${change} changes cannot be hidden by matching model ids or text`);
  }
  const manual={...claims[0],id:'independent-human-claim'};const independentLedger=structuredClone(ledger);independentLedger.entries.push(normalizeEvidenceRecord({id:manual.id,kind:'paper-claim',title:'Human claim',summary:manual.text,metadata:{evidenceIds:manual.evidenceIds},verificationStatus:'human-confirmed'},{now}));
  const independentWorkflow=structuredClone(workflow);independentWorkflow.stages.find(stage=>stage.id==='writing').data.claims.push(manual);const rows=claimRows(independentLedger,independentWorkflow);assert.equal(rows.length,4);assert.equal(rows.find(row=>row.id===manual.id).verificationStatus,'human-confirmed');
  assert.equal(claimRows(ledger,workflow,claims).length,6,'explicitly supplied claims do not gain generated-workflow aliases');
});
