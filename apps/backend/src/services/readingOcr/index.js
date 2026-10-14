import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { getProjectRoot } from '../projectService.js';
import { getPaper } from '../projectHub/paperLibrary.js';
import { createTask, getStoredTask, listStoredTasks, updateTask } from '../projectHub/taskCenter.js';
import { withHubLock } from '../projectHub/repository.js';
import { createAttachmentRepository } from '../paperAttachments/repository.js';
import { translationService } from '../translation/index.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { capabilities, recognize } from './vision.js';

const stamp = () => new Date().toISOString();
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const rect = z.object({ x:z.number().min(0).max(1), y:z.number().min(0).max(1), width:z.number().positive().max(1), height:z.number().positive().max(1) }).strict().refine(r=>r.x+r.width<=1.000001&&r.y+r.height<=1.000001);
const sourceSchema = z.object({ attachmentId:id,fileSha256:z.string().regex(/^[a-f0-9]{64}$/),page:z.number().int().positive().max(10000),region:rect,rotation:z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]) }).strict();
const inputSchema = z.object({operationId,source:sourceSchema,language:z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/)}).strict();
const text = z.string().max(10000).refine(s=>s.isWellFormed()&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s));
const correctionSchema = z.object({expectedRevision:z.number().int().nonnegative(),text}).strict();
const translateSchema = z.object({expectedRevision:z.number().int().nonnegative(),operationId,providerId:id,targetLanguage:z.string().max(32)}).strict();
const receiptsSchema = z.array(z.object({operationId,taskId:id,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(4096);
const resultSchema = z.object({text,lines:z.array(z.object({text,confidence:z.number().min(0).max(1),rect})).max(1000),engine:z.string(),version:z.string(),language:z.string(),basis:z.literal('crop-image-top-left-normalized'),width:z.number().int().positive().max(6000),height:z.number().int().positive().max(6000)}).passthrough();
const activeStatuses = new Set(['queued','running','paused']);
export class ReadingOcrError extends Error { constructor(code,message,statusCode=400){super(message);this.code=code;this.statusCode=statusCode;} }
const fail=(code,message,status=400)=>{throw new ReadingOcrError(code,message,status);};
function parse(schema,value){const result=schema.safeParse(value);if(!result.success)fail('OCR_INVALID_INPUT','请选择有效PDF区域、语言及当前文字版本。');return result.data;}
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};

/** Task Center owns status/results. This file only keeps request receipts, not a second job ledger. */
export function createReadingOcrService({engine={capabilities,recognize},attachments=createAttachmentRepository(),translate=translationService.translate.bind(translationService),resolveProject=getProjectRoot,lookupPaper=getPaper,processAlive=alive}={}) {
  const active=new Map(),ownerId=randomUUID();
  let reservations = 0;
  const lock=(project,fn)=>withHubLock(`reading-ocr:${project}`,fn);
  const key=(project,taskId)=>`${project}:${taskId}`;
  async function paper(project,paperId){try{await lookupPaper(project,paperId);}catch(e){if(e.message==='Paper not found.'||e.code==='ENOENT')fail('OCR_PAPER_NOT_FOUND','当前项目没有这篇论文。',404);throw e;}}
  async function receipts(project,next) {
    const root=await resolveProject(project),file=safeJoin(root,'.scienceprism/reading-ocr-requests.json');
    if(next){const tmp=safeJoin(root,`.scienceprism/.reading-ocr-${randomUUID()}.tmp`);await fs.mkdir(path.dirname(file),{recursive:true});try{await fs.writeFile(tmp,JSON.stringify(next),{flag:'wx',mode:0o600});safeJoin(root,'.scienceprism/reading-ocr-requests.json');await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}return next;}
    let handle;try{handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw new Error('Invalid receipt file');const parsed=receiptsSchema.safeParse(JSON.parse(await handle.readFile('utf8')));if(!parsed.success||new Set(parsed.data.map(r=>r.operationId)).size!==parsed.data.length)throw new Error('Invalid receipts');return parsed.data;}
    catch(e){if(e.code==='ENOENT')return[];fail('OCR_STORAGE_INVALID','OCR请求记录无法读取，已保留原文件。',500);}finally{await handle?.close();}
  }
  async function owned(project,paperId,taskId){let task;try{task=await getStoredTask(project,taskId);}catch{fail('OCR_TASK_NOT_FOUND','没有该论文的OCR记录。',404);}if(task.kind!=='paper-ocr'||task.metadata?.ocr?.source?.paperId!==paperId)fail('OCR_TASK_NOT_FOUND','没有该论文的OCR记录。',404);return task;}
  async function patch(project,taskId,change,metadata={}){const task=await getStoredTask(project,taskId);return updateTask(project,taskId,{...change,metadata:{ocr:{...task.metadata.ocr,...metadata}}});}
  async function reconcile(project,task){
    if(task.kind!=='paper-ocr'||!activeStatuses.has(task.status)||active.has(key(project,task.id)))return task;
    return lock(project,async()=>{task=await getStoredTask(project,task.id);if(!activeStatuses.has(task.status)||active.has(key(project,task.id)))return task;const worker=task.metadata.ocr.worker;
      if((worker?.ownerId!==ownerId&&processAlive(worker?.ownerPid))||(!worker?.stopConfirmed&&processAlive(worker?.pid)))return task;
      return patch(project,task.id,{status:'failed',retryable:true,finishedAt:stamp(),error:{code:'OCR_INTERRUPTED',message:'原识别进程已结束，结果未完成；可以显式重试。'}},{worker:{...worker,stopConfirmed:true}});
    });
  }
  async function execute(project,task,bytes,entry){let workspace;let worker={ownerId,ownerPid:process.pid,pid:null,stopConfirmed:true};
    try{
      await lock(project,()=>patch(project,task.id,{status:'running',progress:null,startedAt:stamp()},{worker}));
      entry.controller.signal.throwIfAborted();
      const root=await resolveProject(project),base=safeJoin(root,'.scienceprism/reading-ocr-work');await fs.mkdir(base,{recursive:true});workspace=await fs.mkdtemp(path.join(base,'region-'));const pdfPath=path.join(workspace,'source.pdf');await fs.writeFile(pdfPath,bytes,{flag:'wx',mode:0o600});
      const input=task.metadata.ocr;
      const raw=parse(resultSchema,await engine.recognize({pdfPath,page:input.source.page,region:input.source.region,rotation:input.source.rotation,language:input.language,signal:entry.controller.signal,onProcess:async state=>{worker={ownerId,ownerPid:process.pid,...state};await lock(project,()=>patch(project,task.id,{}, {worker}));}}));
      if(Buffer.byteLength(JSON.stringify(raw))>128*1024)fail('OCR_RESULT_TOO_LARGE','识别区域文字过多，请缩小区域。',413);
      entry.controller.signal.throwIfAborted();
      await lock(project,()=>{entry.controller.signal.throwIfAborted();return patch(project,task.id,{status:'completed',progress:100,retryable:false,finishedAt:stamp(),error:null},{raw,correction:{revision:0,text:raw.text,updatedAt:stamp()},worker});});
    }catch(error){
      const stopped=worker.stopConfirmed||(!processAlive(worker.pid)&&!error.code?.includes('STOP_UNCONFIRMED'));
      worker={...worker,stopConfirmed:stopped};
      const cancelled=entry.controller.signal.aborted&&stopped;
      await lock(project,()=>patch(project,task.id,{status:!stopped?'paused':cancelled?'cancelled':'failed',progress:null,retryable:stopped,finishedAt:stopped?stamp():null,error:{code:!stopped?'OCR_STOP_UNCONFIRMED':cancelled?'OCR_CANCELLED':error.code||'OCR_FAILED',message:!stopped?'未能确认识别进程停止，请保留原任务。':cancelled?'识别已取消。':error.statusCode?error.message:'本地识别失败，可以缩小区域后重试。'}},{worker:{...worker,stopConfirmed:stopped}}));
    }finally{
      try { if(workspace&&worker.stopConfirmed)await fs.rm(workspace,{recursive:true,force:true}); }
      finally { active.delete(key(project,task.id)); }
    }
  }
  async function start(project,paperId,input,{retryOf}={}){
    const body=parse(inputSchema,input);await paper(project,paperId);
    for(const task of await listStoredTasks(project))if(task.kind==='paper-ocr')await reconcile(project,task);
    return lock(project,async()=>{
      const saved=await receipts(project),fingerprint=digest({paperId,...body.source,language:body.language});const previous=saved.find(r=>r.operationId===body.operationId);
      if(previous){if(previous.fingerprint!==fingerprint)fail('OCR_OPERATION_CONFLICT','该请求ID已用于其它区域或语言。',409);try{return{task:await owned(project,paperId,previous.taskId)};}catch(e){if(e.code==='OCR_TASK_NOT_FOUND')fail('OCR_RESULT_UNAVAILABLE','原请求记录已保留，但任务结果已移出保留范围；不会自动重新识别。',409);throw e;}}
      const configured=await engine.capabilities();if(!configured.available)fail('OCR_UNAVAILABLE',configured.reason||'本机OCR尚未配置，可继续阅读和记录笔记。',503);if(!configured.languages.includes(body.language))fail('OCR_LANGUAGE_UNSUPPORTED','请选择本机识别引擎支持的语言。');
      const {attachment,bytes}=await attachments.content(project,paperId,body.source.attachmentId);if(attachment.sha256!==body.source.fileSha256||body.source.page>attachment.pageCount)fail('OCR_SOURCE_CHANGED','PDF版本或页码已变化，请重新框选。',409);
      const tasks=(await listStoredTasks(project)).filter(t=>t.kind==='paper-ocr');
      const busy=tasks.find(t=>activeStatuses.has(t.status));if(busy)fail('OCR_BUSY','项目已有未结束的OCR任务，请先查看或取消。',409);
      const inputHash=digest({fingerprint,engine:configured.engine,version:configured.version});
      const cached=tasks.find(t=>t.status==='completed'&&t.metadata.ocr.inputHash===inputHash&&t.metadata.ocr.raw);
      if(!cached&&active.size+reservations>=2)fail('OCR_BUSY','本机正在识别其它区域，请稍后再试。',429);
      if(saved.length>=4096)fail('OCR_RECEIPTS_FULL','项目OCR请求记录已达上限，现有结果保留。',409);
      if(!cached)reservations++;
      try {
      const taskId=`task-ocr-${randomUUID()}`;
      await receipts(project,[...saved,{operationId:body.operationId,taskId,fingerprint}]);
      const raw=cached?structuredClone(cached.metadata.ocr.raw):null;
      const task=await createTask(project,{id:taskId,kind:'paper-ocr',title:`PDF区域识别 · 第${body.source.page}页`,status:cached?'completed':'queued',progress:cached?100:null,retryable:false,metadata:{ocr:{source:{paperId,...body.source},operationId:body.operationId,inputHash,language:body.language,engine:configured.engine,version:configured.version,raw,correction:raw?{revision:0,text:raw.text,updatedAt:stamp()}:null,translations:[],cachedFromTaskId:cached?.id||null,retryOf:retryOf||null,worker:{ownerId,ownerPid:process.pid,pid:null,stopConfirmed:true}}}});
      if(!cached){const entry={controller:new AbortController(),done:null};active.set(key(project,task.id),entry);entry.done=Promise.resolve().then(()=>execute(project,task,bytes,entry));entry.done.catch(()=>{});}
      return{task};
      } finally { if(!cached)reservations--; }
    });
  }
  const service={
    async list(project,paperId){await paper(project,paperId);const tasks=[];for(const task of await listStoredTasks(project))if(task.kind==='paper-ocr'&&task.metadata?.ocr?.source.paperId===paperId)tasks.push(await reconcile(project,task));return{capabilities:await engine.capabilities(),tasks};},
    async get(project,paperId,taskId){await paper(project,paperId);return{task:await reconcile(project,await owned(project,paperId,taskId))};},
    reconcile,start,
    async cancel(project,paperId,taskId){let task=(await service.get(project,paperId,taskId)).task;const entry=active.get(key(project,taskId));if(!entry){if(!activeStatuses.has(task.status))return{task};fail('OCR_OWNER_UNAVAILABLE','原识别进程仍可能运行，无法在此进程确认停止。',409);}entry.controller.abort();await entry.done;return{task:await owned(project,paperId,taskId)};},
    async retry(project,paperId,taskId,input={operationId:randomUUID()}){const {task}=await service.get(project,paperId,taskId);if(!task.retryable||!['failed','cancelled'].includes(task.status))fail('OCR_NOT_RETRYABLE','请等待原识别进程结束后再重试。',409);const {paperId:ignored,...source}=task.metadata.ocr.source;return start(project,paperId,{...parse(z.object({operationId}).strict(),input),source,language:task.metadata.ocr.language},{retryOf:task.id});},
    async correct(project,paperId,taskId,input){const body=parse(correctionSchema,input);return lock(project,async()=>{const task=await owned(project,paperId,taskId),ocr=task.metadata.ocr;if(task.status!=='completed'||!ocr.correction)fail('OCR_NOT_COMPLETE','请等待识别完成。',409);if(ocr.correction.revision!==body.expectedRevision)fail('OCR_CORRECTION_CONFLICT','文字版本已变化，输入已保留，请刷新后核对。',409);return{task:await patch(project,task.id,{}, {correction:{revision:body.expectedRevision+1,text:body.text,updatedAt:stamp()}})};});},
    async translate(project,paperId,taskId,input,{signal}={}){
      const body=parse(translateSchema,input);let selected;
      const saved=await lock(project,async()=>{const task=await owned(project,paperId,taskId),ocr=task.metadata.ocr;if(task.status!=='completed'||!ocr.correction)fail('OCR_NOT_COMPLETE','请等待识别完成。',409);if(ocr.correction.revision!==body.expectedRevision)fail('OCR_CORRECTION_CONFLICT','请先保存并核对当前文字版本。',409);const previous=ocr.translations.find(t=>t.operationId===body.operationId);if(previous){if(previous.correctionRevision!==body.expectedRevision||previous.providerId!==body.providerId||previous.targetLanguage!==body.targetLanguage)fail('OCR_OPERATION_CONFLICT','翻译请求ID已用于其它版本或来源。',409);return{task,translation:previous};}if(ocr.translations.length>=20)fail('OCR_TRANSLATION_LIMIT','该区域已保存20条翻译，请保留现有记录。',409);selected=structuredClone(ocr);return null;});
      if(saved)return saved;
      const translation=await translate(project,{operationId:body.operationId,selectionId:`${taskId}:${body.expectedRevision}`,text:selected.correction.text,providerId:body.providerId,targetLanguage:body.targetLanguage,sourceLanguage:'auto',source:{paperId,attachmentId:selected.source.attachmentId,fileSha256:selected.source.fileSha256,page:selected.source.page}},{signal});
      signal?.throwIfAborted();
      return lock(project,async()=>{signal?.throwIfAborted();const task=await owned(project,paperId,taskId),ocr=task.metadata.ocr;const previous=ocr.translations.find(t=>t.operationId===body.operationId);if(previous)return{task,translation:previous};if(ocr.translations.length>=20)fail('OCR_TRANSLATION_LIMIT','该区域已保存20条翻译。',409);const result={...translation,correctionRevision:body.expectedRevision};return{task:await patch(project,taskId,{}, {translations:[...ocr.translations,result]}),translation:result};});
    }
  };
  return service;
}
export const readingOcrService=createReadingOcrService();
