import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createDatasetRepository } from './repository.js';
import { createDatasetDownloader, DatasetError, MAX_DATASET_BYTES, parseDatasetUrl, SUPPORTED_DATASET_HOSTS } from './download.js';
import { datasetFilename } from './preview.js';
import { claimAutomationOwner, inspectAutomationOwner } from '../researchAutomation/owner.js';
import { sourceHash } from '../researchAutomation/handoff.js';
export { DatasetError } from './download.js';

const at = () => new Date().toISOString();
const terminal = job => ['completed','failed','cancelled'].includes(job.status);
const text = limit => z.string().trim().min(1).max(limit).refine(value => value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value));
const metadata = z.object({ filename: text(240), name: text(240).optional(), license: text(300).optional(),
  split: z.enum(['train','validation','test','unknown']).default('unknown'), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const downloadSchema = metadata.extend({ url: text(4096), maxBytes: z.number().int().min(1).max(MAX_DATASET_BYTES).default(MAX_DATASET_BYTES), refresh: z.boolean().default(false) }).strict();
const fail = (code,message,status=409) => { throw new DatasetError(code,message,status); };
function validated(schema,input) {
  const result=schema.safeParse(input);
  if(!result.success) fail('DATASET_INVALID_INPUT','请提供支持的数据文件、公开来源及有效预算。',400);
  datasetFilename(result.data.filename); return result.data;
}
function sourceFor(url) {
  const parsed=parseDatasetUrl(url), segments=parsed.pathname.split('/').filter(Boolean);
  return { kind: parsed.hostname==='huggingface.co'?'huggingface':'https', url:parsed.toString(), revision:parsed.hostname==='huggingface.co'?segments[segments.indexOf('resolve')+1]:null };
}
const hidden = job => {
  const { resolvedUrl, etag, ...visible }=job;
  return structuredClone(visible);
};
/** Acquisition owns its frozen request, immutable result, cancellation and
 * recovery. A separate protected resource lease uses the existing process
 * owner protocol at the dataset storage root. */
export function createDatasetService({ repository=createDatasetRepository(), download }={}) {
  const active=new Map(), failures=new Map(), key=(projectId,id)=>`${projectId}:${id}`;
  async function ownerFor(projectId,id) {
    const {control}=await repository.locations(projectId,{create:true});
    try { return claimAutomationOwner({projectRoot:control,sessionId:id}); }
    catch(error) { fail('DATASET_PROJECT_BUSY',error.code==='AUTOMATION_OWNER_BUSY'?'项目已有数据任务；停止或等待后再继续。':'数据任务归属无法安全确认，请保留记录。'); }
  }
  async function record(projectId,id) {
    const job=(await repository.read(projectId)).jobs.find(item=>item.id===id);
    if(!job) fail('DATASET_JOB_NOT_FOUND','本项目没有这个数据获取任务。',404);
    if(!/^dataset-job-[a-f0-9-]{36}$/.test(job.id)||job.configuration?.version!==1||sourceHash(job.configuration)!==job.configurationSha256) fail('DATASET_CONFIGURATION_CHANGED','任务配置或版本发生变化，不能自动重新下载。');
    return job;
  }
  function view(projectId,job,owner) {
    const result=hidden(job);
    if(failures.has(key(projectId,job.id))) return {...result,status:'interrupted',error:failures.get(key(projectId,job.id)),message:'数据回执未能保存，请核对后继续原任务。'};
    if(!terminal(job)&&!active.has(key(projectId,job.id))) {
      if(owner?.sessionId===job.id&&!owner.released&&owner.present!==false) return {...result,status:'running',message:'数据任务仍由原执行进程持有。'};
      return {...result,status:'interrupted',interrupted:true,message:'执行进程已停止，可核对已有文件后继续原任务。'};
    }
    return result;
  }
  async function change(projectId,job,entry,patch) {
    return repository.update(projectId,index=>{
      const current=index.jobs.find(item=>item.id===job.id);
      if(!current||current.configurationSha256!==job.configurationSha256) fail('DATASET_CONFIGURATION_CHANGED','任务配置已变化。');
      Object.assign(current,patch,{updatedAt:at()}); return current;
    },{owner:entry.owner});
  }
  async function execute(projectId,job,entry) {
    try {
      entry.controller.signal.throwIfAborted();
      await change(projectId,job,entry,{status:'running',ownerPid:process.pid,startedAt:job.startedAt||at(),error:null});
      const root=await repository.locations(projectId,{create:true});
      const partial=path.join(root.parts,`${job.id}.part`), config=job.configuration;
      if(config.source.kind!=='import'&&!job.verifiedContent) {
        const downloader=download||createDatasetDownloader({maxBytes:config.maxBytes});
        const result=await downloader(config.source.url,{destination:partial,signal:entry.controller.signal,
          resume:{receivedBytes:job.receivedBytes,etag:job.etag,resolvedUrl:job.resolvedUrl},
          onProgress:async progress=>{
            if(progress.receivedBytes>config.maxBytes||progress.totalBytes>config.maxBytes) fail('DATASET_TOO_LARGE','数据超出本任务授权的体积预算。',413);
            await change(projectId,job,entry,{receivedBytes:progress.receivedBytes,totalBytes:progress.totalBytes,etag:progress.etag,resolvedUrl:progress.resolvedUrl});
          }});
        if(result.byteLength>config.maxBytes) fail('DATASET_TOO_LARGE','数据超出本任务体积预算。',413);
        if(config.expectedSha256&&result.sha256!==config.expectedSha256) fail('DATASET_HASH_MISMATCH','下载内容与预期SHA256不符，未生成数据版本。');
        await change(projectId,job,entry,{verifiedContent:{sha256:result.sha256,byteLength:result.byteLength}});
        job={...job,verifiedContent:{sha256:result.sha256,byteLength:result.byteLength}};
      } else if(config.source.kind==='import') {
        const stat=await fs.lstat(partial);
        if(stat.size!==config.byteLength) fail('DATASET_IMPORT_INCOMPLETE','本地文件没有完整上传，请重新选择原文件导入。');
      }
      entry.controller.signal.throwIfAborted(); entry.phase='committing';
      await change(projectId,job,entry,{status:'committing'});
      const stored=await repository.store(projectId,partial,{filename:config.filename,name:config.name,source:config.source,
        license:config.license,split:config.split,expectedSha256:config.expectedSha256||job.verifiedContent?.sha256},{owner:entry.owner});
      await change(projectId,job,entry,{status:'completed',datasetId:stored.dataset.id,duplicate:stored.duplicate,
        receivedBytes:stored.dataset.byteLength,totalBytes:stored.dataset.byteLength,finishedAt:at(),error:null});
      await fs.rm(partial,{force:true});
    } catch(cause) {
      const cancelled=entry.controller.signal.aborted&&entry.phase!=='committing';
      const error=cancelled?{code:'DATASET_CANCELLED',message:'已停止获取；完整回执和已接收文件保留。'}
        :cause instanceof DatasetError?{code:cause.code,message:cause.message}:{code:'DATASET_ACQUISITION_FAILED',message:'数据获取失败；可继续原任务或导入原始文件。'};
      await change(projectId,job,entry,{status:cancelled?'cancelled':'failed',error,finishedAt:at()});
    } finally {
      try { entry.owner.release({stopConfirmed:true}); } finally { active.delete(key(projectId,job.id)); }
    }
  }
  function launch(projectId,job,owner) {
    const entry={owner,controller:new AbortController(),phase:'downloading',promise:null};
    active.set(key(projectId,job.id),entry);failures.delete(key(projectId,job.id));
    entry.promise=execute(projectId,job,entry).catch(()=>{failures.set(key(projectId,job.id),{code:'DATASET_RECEIPT_SAVE_FAILED',message:'获取结果的持久回执未能保存，不能报告完成。'});});
    return entry;
  }
  async function create(projectId,config,{refresh=false}={}) {
    const id=`dataset-job-${randomUUID()}`,owner=await ownerFor(projectId,id);
    try {
      const result=await repository.update(projectId,async index=>{
        const signature=sourceHash(config);
        const previous=!refresh&&index.jobs.findLast(item=>item.configurationSha256===signature&&item.status==='completed');
        if(previous){const {dataset}=await repository.content(projectId,previous.datasetId);return {job:previous,dataset,cached:true};}
        if(index.jobs.length>=1000) fail('DATASET_JOB_LIMIT','数据任务记录已达到上限，请检查已有任务。');
        const job={id,projectId,configuration:config,configurationSha256:signature,status:'queued',ownerPid:process.pid,receivedBytes:0,totalBytes:null,
          datasetId:null,createdAt:at(),updatedAt:at(),startedAt:null,finishedAt:null,error:null};index.jobs.push(job);return {job,cached:false};
      },{owner});
      if(result.cached){owner.release({stopConfirmed:true});return {...result,job:hidden(result.job)};}
      return {job:result.job,owner,cached:false};
    } catch(error){owner.release({stopConfirmed:true});throw error;}
  }
  return {
    async list(projectId){const index=await repository.read(projectId);const owner=index.jobs.some(job=>!terminal(job)&&!active.has(key(projectId,job.id)))?inspectAutomationOwner({projectRoot:(await repository.locations(projectId)).control}):null;
      return {datasets:index.datasets,jobs:index.jobs.map(job=>view(projectId,job,owner)),supportedHosts:[...SUPPORTED_DATASET_HOSTS],maxBytes:MAX_DATASET_BYTES};},
    async listJobs(projectId){return (await this.list(projectId)).jobs;},
    async get(projectId,datasetId){const {dataset}=await repository.content(projectId,datasetId);return dataset;},
    content:(projectId,datasetId)=>repository.content(projectId,datasetId),
    async importData(projectId,{bytes,...input}) {
      const body=validated(metadata.strict(),input);
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_DATASET_BYTES) fail('DATASET_TOO_LARGE','请选择非空、未超过128MiB的数据文件。',413);
      const config={version:1,authority:'human',capability:'dataset.acquire',source:{kind:'import',url:null,revision:null},filename:body.filename,
        name:body.name||body.filename,license:{label:body.license||'未记录',verified:false},split:body.split,byteLength:bytes.length,
        expectedSha256:body.expectedSha256||createHash('sha256').update(bytes).digest('hex'),maxBytes:MAX_DATASET_BYTES};
      const result=await create(projectId,config);
      if(result.cached)return result;
      const root=await repository.locations(projectId,{create:true}),partial=path.join(root.parts,`${result.job.id}.part`);
      let launched=false;
      try{await fs.writeFile(partial,bytes,{flag:'wx',mode:0o600});const entry=launch(projectId,result.job,result.owner);launched=true;await entry.promise;
        const job=await record(projectId,result.job.id);if(job.status!=='completed')fail(job.error?.code||'DATASET_IMPORT_FAILED',job.error?.message||'数据导入失败。');
        return {job:hidden(job),dataset:await this.get(projectId,job.datasetId),cached:false};}
      catch(error){if(!launched){try{await change(projectId,result.job,{owner:result.owner},{status:'failed',finishedAt:at(),error:{code:'DATASET_IMPORT_WRITE_FAILED',message:'本地文件未能完整写入；请保留原文件后重新导入。'}});}finally{result.owner.release({stopConfirmed:true});}}
        if(error instanceof DatasetError)throw error;fail('DATASET_IMPORT_WRITE_FAILED','本地文件写入失败，请检查存储后重新导入。',500);}
    },
    async startDownload(projectId,input){const body=validated(downloadSchema,input),config={version:1,authority:'human',capability:'dataset.acquire',source:sourceFor(body.url),
      filename:body.filename,name:body.name||body.filename,license:{label:body.license||'未记录',verified:false},split:body.split,maxBytes:body.maxBytes,...(body.expectedSha256?{expectedSha256:body.expectedSha256}:{})};
      const result=await create(projectId,config,{refresh:body.refresh});if(result.cached)return result;launch(projectId,result.job,result.owner);return {job:hidden(result.job),cached:false};},
    async getJob(projectId,id){const job=await record(projectId,id);const owner=!terminal(job)&&!active.has(key(projectId,id))?inspectAutomationOwner({projectRoot:(await repository.locations(projectId)).control}):null;return view(projectId,job,owner);},
    async resume(projectId,id,{expectedConfigurationVersion}={}) {
      const job=await record(projectId,id);
      if(expectedConfigurationVersion!==job.configuration.version)fail('DATASET_CONFIGURATION_CONFLICT','获取配置版本已变化，请重新读取原任务。');
      if(job.status==='completed'){const {dataset}=await repository.content(projectId,job.datasetId);return {job:hidden(job),dataset,cached:true};}
      if(active.has(key(projectId,id)))fail('DATASET_ACTIVE','原任务仍在执行。');
      const owner=await ownerFor(projectId,id);launch(projectId,job,owner);return {job:hidden(job),cached:false};
    },
    async cancel(projectId,id){const job=await record(projectId,id),entry=active.get(key(projectId,id));
      if(entry){if(entry.phase!=='committing')entry.controller.abort(new DatasetError('DATASET_CANCELLED','数据任务已停止。'));await entry.promise;}
      else if(!terminal(job)){const owner=await ownerFor(projectId,id);try{await repository.update(projectId,index=>{const current=index.jobs.find(item=>item.id===id);Object.assign(current,{status:'cancelled',finishedAt:at(),updatedAt:at(),error:{code:'DATASET_CANCELLED',message:'后续获取已停止，可继续原任务。'}});return current;},{owner});}finally{owner.release({stopConfirmed:true});}}
      return this.getJob(projectId,id);
    },
    async shutdown(){await Promise.all([...active.values()].map(async entry=>{if(entry.phase!=='committing')entry.controller.abort();await entry.promise;}));}
  };
}
export const datasetService=createDatasetService();
