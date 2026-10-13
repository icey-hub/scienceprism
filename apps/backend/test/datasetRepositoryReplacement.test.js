import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDatasetRepository } from '../src/services/datasets/repository.js';

async function fixture(t) {
  const base=path.resolve('.cache/dataset-index-replacement-tests');await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'case-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repository=createDatasetRepository({resolveProject:async()=>root});await repository.update('replacement',()=>{});
  return {repository,index:(await repository.locations('replacement')).index};
}
test('an index atomically replaced after open is reread without accepting detached blob storage',async t=>{
  const {repository,index}=await fixture(t),open=fs.open;let replaced=false,detachedLinks=null;
  fs.open=async function(target,...args){
    const handle=await open(target,...args);
    if(target===index&&!replaced){
      const stat=handle.stat.bind(handle);
      handle.stat=async()=>{
        replaced=true;await repository.update('replacement',()=>{});
        const result=await stat();detachedLinks=result.nlink;return result;
      };
    }
    return handle;
  };
  try{const current=await repository.read('replacement');assert.equal(detachedLinks,0);assert.equal(current.version,3);}
  finally{fs.open=open;}
});
test('index replacement recovery still rejects a hard-linked current index',async t=>{
  const {repository,index}=await fixture(t);await fs.link(index,`${index}.other`);
  await assert.rejects(repository.read('replacement'),{code:'DATASET_UNSAFE_STORAGE'});
});
