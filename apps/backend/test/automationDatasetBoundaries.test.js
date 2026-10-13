import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {createDatasetDownloader,DatasetError} from '../src/services/datasets/download.js';
import {createDatasetRepository} from '../src/services/datasets/repository.js';
const cache=fileURLToPath(new URL('../../../.cache/research-workbench-v2/automation-dataset/',import.meta.url));
await fs.mkdir(cache,{recursive:true});const root=await fs.mkdtemp(path.join(cache,'boundaries-'));after(()=>fs.rm(root,{recursive:true,force:true}));
const url='https://raw.githubusercontent.com/example/repo/main/data.csv';
function response(status,headers,body=''){return Object.assign(Readable.from(body?[Buffer.from(body)]:[]),{statusCode:status,headers});}
test('download rechecks authorization after DNS immediately before the real request callback',async()=>{
 let allowed=true,requests=0;
 const download=createDatasetDownloader({proxyUrl:'',lookupImpl:async()=>{allowed=false;return [{address:'8.8.8.8',family:4}];},requestImpl:()=>{requests++;return response(200,{'content-length':'1'},'x');}});
 const destination=path.join(root,'first.csv');
 await assert.rejects(download(url,{destination,beforeRequest:()=>{if(!allowed)throw new DatasetError('TEST_REVOKED','revoked',403);}}),{code:'TEST_REVOKED'});
 assert.equal(requests,0);assert.equal((await fs.stat(destination)).size,0);
});
test('every redirect request uses the current authorization rather than reusing its first admission',async()=>{
 let requests=0,checks=0;
 const download=createDatasetDownloader({proxyUrl:'',lookupImpl:async()=>[{address:'8.8.8.8',family:4}],requestImpl:()=>{requests++;return response(302,{location:'https://raw.githubusercontent.com/example/repo/main/changed.csv'});}});
 await assert.rejects(download(url,{destination:path.join(root,'redirect.csv'),beforeRequest:()=>{if(++checks===2)throw new DatasetError('TEST_REVOKED','revoked',403);}}),{code:'TEST_REVOKED'});
 assert.equal(requests,1);assert.equal(checks,2);
});
test('revocation after raw copy but before atomic index publication leaves no usable dataset version',async()=>{
 const project=path.join(root,'publication');await fs.mkdir(project);const repository=createDatasetRepository({resolveProject:async()=>project});const locations=await repository.locations('publication',{create:true});
 const partial=path.join(locations.parts,'source.part');await fs.writeFile(partial,'name,value\nA,1\n');let checks=0;
 await assert.rejects(repository.store('publication',partial,{filename:'data.csv',source:{kind:'https',url}},{beforePublish:()=>{if(++checks===2)throw new DatasetError('TEST_REVOKED','revoked',403);}}),{code:'TEST_REVOKED'});
 assert.equal(checks,2);assert.equal((await repository.read('publication')).datasets.length,0);assert.equal(await fs.readFile(partial,'utf8'),'name,value\nA,1\n');
});

test('the owning research task blocks a supported redirect outside its selected source scope',async t=>{
 const {createDatasetService}=await import('../src/services/datasets/index.js');
 const {acquireAutomationDataset}=await import('../src/services/researchAutomation/datasetAcquisition.js');
 const project=path.join(root,'scope-redirect');await fs.mkdir(project);let requests=0;
 const download=createDatasetDownloader({proxyUrl:'',lookupImpl:async()=>[{address:'8.8.8.8',family:4}],requestImpl:()=>{requests++;return requests===1?response(302,{location:'https://zenodo.org/records/1/files/data.csv'}):response(200,{'content-length':'8'},'x,y\n1,2\n');}});
 const service=createDatasetService({repository:createDatasetRepository({resolveProject:async()=>project}),download});t.after(()=>service.shutdown());
 const state={version:1,policy:{enabled:true,overrides:{},datasetScope:{allowedHosts:['raw.githubusercontent.com'],maxBytes:1024,maxDatasets:1}},session:{id:'session-redirect',coordinatorRunId:'parent-redirect',status:'running',steps:[{stage:'replication',calls:[{runId:'producer-redirect',task:'research:dataset_discovery'}]}]}};
 await assert.rejects(acquireAutomationDataset({projectId:'scope-redirect',session:state.session,stage:'replication',proposal:{paperId:'p1',url,filename:'data.csv'},sourceRunId:'producer-redirect',service,
  readState:async()=>structuredClone(state),readRun:async()=>({id:'producer-redirect',projectId:'scope-redirect',parentRunId:'parent-redirect',automationSessionId:'session-redirect',stage:'replication',status:'completed',task:'research:dataset_discovery'}),saveStep:async patch=>Object.assign(state.session.steps[0],structuredClone(patch)),beforeEffect:async()=>{}}),{code:'DATASET_AUTHORIZATION_REVOKED'});
 assert.equal(requests,1);assert.equal((await service.list('scope-redirect')).datasets.length,0);
});
