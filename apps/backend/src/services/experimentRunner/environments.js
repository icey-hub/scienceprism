import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getProjectRoot } from '../projectService.js';
import { withHubLock } from '../projectHub/repository.js';
import { claimAutomationOwner, inspectAutomationOwner } from '../researchAutomation/owner.js';
import { isPathAllowed, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { safeJoin } from '../../utils/pathUtils.js';
import { ExperimentRunnerError } from './errors.js';
import { preparePythonEnvironment, probePythonEnvironmentCapability } from './pythonEnvironmentRuntime.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const at = () => new Date().toISOString();
const fail = (code, message, status = 409) => { throw new ExperimentRunnerError(status, code, message); };
const finished = job => ['ready', 'failed', 'cancelled'].includes(job.status);
const identifier = /^environment-[a-f0-9-]{36}$/;
const configSchema = z.object({ packages: z.array(z.object({ path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(30).default([]),
  timeoutMs: z.number().int().min(100).max(600000).default(120000), maxOutputBytes: z.number().int().min(1024).max(2*1024*1024).default(1024*1024) }).strict();

function directory(target, create = false) {
  if (create) { try { fs.mkdirSync(target, {mode:0o700}); } catch (e) { if(e.code!=='EEXIST')throw e; } }
  const stat=fs.lstatSync(target);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(target)!==target||process.getuid&&stat.uid!==process.getuid()) fail('ENVIRONMENT_STORAGE_UNSAFE','环境目录必须是本机账户持有的普通目录。');
}
async function regular(target, limit=128*1024*1024, atomicSnapshot=false) {
  const file=await fsp.open(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1&&!(atomicSnapshot&&stat.nlink===0)||stat.size>limit)fail('ENVIRONMENT_FILE_INVALID','依赖必须是有界、无链接的普通文件。');const bytes=await file.readFile();return {bytes,sha256:hash(bytes)};} finally {await file.close();}
}
export function validateEnvironmentConfiguration(input) {
  const parsed=configSchema.safeParse(input);
  if(!parsed.success)fail('ENVIRONMENT_CONFIG_INVALID','请提供固定的依赖文件、SHA256和准备预算。',400);
  const value=parsed.data;
  for(const wheel of value.packages) if(/[\x00-\x1f\x7f]/.test(wheel.path)||wheel.path!==path.posix.normalize(wheel.path)||wheel.path.includes('\\')||wheel.path.startsWith('/')||wheel.path.split('/').some(p=>!p||p==='.'||p==='..')||isSensitivePath(wheel.path)||!wheel.path.endsWith('.whl')) fail('ENVIRONMENT_CONFIG_INVALID','依赖文件必须是项目内的 .whl 文件。',400);
  if(new Set(value.packages.map(p=>p.path)).size!==value.packages.length||new Set(value.packages.map(p=>path.basename(p.path))).size!==value.packages.length)fail('ENVIRONMENT_CONFIG_INVALID','依赖文件不能重复。',400);
  return value;
}
async function treeDigest(root) {
  let size=0,count=0;const entries=[];
  async function visit(relative='') {
    for(const name of (await fsp.readdir(path.join(root,relative))).sort()){
      const rel=path.posix.join(relative,name),file=path.join(root,rel),stat=await fsp.lstat(file);
      if(++count>50000)fail('ENVIRONMENT_RESOURCE_LIMIT','环境文件数量超过配额。',413);
      if(stat.isSymbolicLink())entries.push({path:rel,link:await fsp.readlink(file)});
      else if(stat.isDirectory())await visit(rel);
      else if(stat.isFile()){size+=stat.size;if(size>256*1024*1024)fail('ENVIRONMENT_RESOURCE_LIMIT','环境超过256MiB磁盘配额。',413);entries.push({path:rel,sha256:(await regular(file,256*1024*1024)).sha256});}
      else fail('ENVIRONMENT_STORAGE_UNSAFE','环境含非普通文件。');
    }
  }
  directory(root);await visit();return {sha256:hash(JSON.stringify(entries)),byteLength:size,fileCount:count};
}

/** Preparation and execution are separate: this service owns the fixed lock,
 * private environment directory and durable process receipt. */
export function createEnvironmentService({resolveProject=getProjectRoot,prepare=preparePythonEnvironment,probe=probePythonEnvironmentCapability}={}) {
  const active=new Map();
  async function locations(projectId,{create=false}={}) {
    let project;try{project=await resolveProject(projectId);directory(project);}catch{fail('ENVIRONMENT_PROJECT_NOT_FOUND','项目不存在或路径不可用。',404);}
    const base=path.join(path.dirname(project),'.scienceprism-environments');
    const control=path.join(base,hash(projectId));
    if(create){directory(base,true);directory(control,true);}else if(fs.existsSync(control)){directory(base);directory(control);}
    return {project,control,index:path.join(control,'index.json')};
  }
  async function read(projectId) {
    const root=await locations(projectId);
    // Atomic rename may unlink an already-open previous index. Its descriptor
    // still provides a complete snapshot; immutable wheel/runtime files do not
    // permit this exception, and hard links remain rejected everywhere.
    try{const data=JSON.parse((await regular(root.index,4*1024*1024,true)).bytes.toString());
      if(data.schemaVersion!==1||data.projectId!==projectId||!Array.isArray(data.jobs)||data.jobs.length>500||new Set(data.jobs.map(j=>j.id)).size!==data.jobs.length||data.jobs.some(j=>!identifier.test(j.id)||hash(JSON.stringify(j.configuration))!==j.configurationSha256))fail('ENVIRONMENT_STORAGE_INVALID','环境准备记录损坏。',500);return data;
    }catch(e){if(e.code==='ENOENT')return {schemaVersion:1,projectId,version:1,jobs:[]};throw e;}
  }
  async function update(projectId,owner,callback,{beforePublish}={}) {
    return withHubLock(projectId,async()=>{owner?.assertOwned();const root=await locations(projectId,{create:true}),doc=await read(projectId),result=await callback(doc,root);
      owner?.assertOwned();doc.version++;const tmp=path.join(root.control,`.index-${randomUUID()}.tmp`);
      try{const encoded=JSON.stringify(doc)+'\n';if(Buffer.byteLength(encoded)>4*1024*1024)fail('ENVIRONMENT_STORAGE_LIMIT','环境准备记录达到上限。');await fsp.writeFile(tmp,encoded,{flag:'wx',mode:0o600});directory(root.control);owner?.assertOwned();await beforePublish?.();await fsp.rename(tmp,root.index);}finally{await fsp.rm(tmp,{force:true});}
      return structuredClone(result);
    });
  }
  async function raw(projectId,id) {if(!identifier.test(id))fail('ENVIRONMENT_NOT_FOUND','本项目没有这个环境。',404);const job=(await read(projectId)).jobs.find(j=>j.id===id);if(!job)fail('ENVIRONMENT_NOT_FOUND','本项目没有这个环境。',404);return job;}
  function assertStopped(job) {
    if(job.process?.stopConfirmed===true||job.status==='queued'&&!job.process)return;
    if(!job.process?.pid)fail('ENVIRONMENT_STOP_UNCONFIRMED','原准备过程缺少停止回执，不能重复启动；请保留记录并核对进程。');
    try{process.kill(job.process.pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
    fail('ENVIRONMENT_STOP_UNCONFIRMED','原准备进程仍在运行，不能重复启动。');
  }
  async function constraintsFor(projectId,config) {
    const {project}=await locations(projectId);let constraints;
    try{constraints=JSON.parse((await regular(path.join(project,'.scienceprism','project-constraints.json'),1024*1024)).bytes.toString());}catch(e){if(e.code==='ENOENT')fail('ENVIRONMENT_PREPARATION_DENIED','请先在项目设置中允许受控实验执行。',403);throw e;}
    if(!Array.isArray(constraints.capabilities)||!constraints.capabilities.includes('experiment.execute')||constraints.allowExperimentExecution===false)fail('ENVIRONMENT_PREPARATION_DENIED','项目未允许受控实验环境准备。',403);
    if(Number.isFinite(Number(constraints.environmentTimeoutMs))&&config.timeoutMs>Number(constraints.environmentTimeoutMs))fail('ENVIRONMENT_RESOURCE_LIMIT','准备时间超过项目配额。',403);
    const allowedPaths=constraints.allowedPaths??constraints.fileScope??[];
    if(!Array.isArray(allowedPaths)||allowedPaths.some(v=>typeof v!=='string')||config.packages.some(p=>!isPathAllowed(p.path,{allowedPaths})))fail('ENVIRONMENT_PATH_DENIED','依赖文件超出项目的允许路径。',403);
    return constraints;
  }
  async function view(projectId,job) {
    if(!finished(job)&&!active.has(job.id)){
      const root=await locations(projectId);const owner=inspectAutomationOwner({projectRoot:root.control});
      return {...job,status:owner?.sessionId===job.id&&!owner.released&&owner.present!==false?'preparing':'interrupted'};
    }return structuredClone(job);
  }
  async function change(projectId,id,owner,patch,options) {return update(projectId,owner,doc=>{const job=doc.jobs.find(j=>j.id===id);if(!job)fail('ENVIRONMENT_NOT_FOUND','环境记录不存在。',404);Object.assign(job,patch,{updatedAt:at()});return job;},options);}
  async function launch(projectId,job,owner,{assertAuthorized:taskGuard,signal}={}) {
    if(job.configuration.authority==='system'&&typeof taskGuard!=='function')fail('ENVIRONMENT_AUTOMATION_OWNED','自动准备任务只能从原研究链路继续。');
    const entry={projectId,owner,controller:new AbortController(),process:null};active.set(job.id,entry);
    const abort=()=>entry.controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    entry.promise=(async()=>{
      try {
        entry.controller.signal.throwIfAborted();await taskGuard?.();
        const root=await locations(projectId),jobRoot=path.join(root.control,job.id);directory(jobRoot,true);
        const dir=path.join(jobRoot,`attempt-${job.attempt+1}`);directory(dir,true);
        const wheelRoot=path.join(dir,'wheels');directory(wheelRoot,true);
        const environmentRoot=path.join(dir,'python');directory(environmentRoot,true);
        const assertAuthorized=async()=>{entry.controller.signal.throwIfAborted();owner.assertOwned();await taskGuard?.();await constraintsFor(projectId,job.configuration);const latest=await raw(projectId,job.id);if(latest.configurationSha256!==job.configurationSha256||latest.status!=='preparing')fail('ENVIRONMENT_CONFIG_CHANGED','环境准备配置或状态已改变。');};
        await change(projectId,job.id,owner,{status:'preparing',attempt:job.attempt+1,startedAt:at(),error:null,process:{pid:null,stopConfirmed:true}});
        await assertAuthorized();let total=0;const wheels=[];
        for(const wheel of job.configuration.packages){let target;try{target=safeJoin(root.project,wheel.path);}catch{fail('ENVIRONMENT_PATH_DENIED','依赖文件不能通过符号链接访问。',403);}const canonical=await fsp.realpath(target);
          if(canonical!==target||!canonical.startsWith(root.project+path.sep))fail('ENVIRONMENT_PATH_DENIED','依赖文件不能通过符号链接访问。',403);
          const actual=await regular(target,32*1024*1024);total+=actual.bytes.length;if(total>128*1024*1024)fail('ENVIRONMENT_RESOURCE_LIMIT','依赖文件总量超过128MiB。',413);
          if(actual.sha256!==wheel.sha256)fail('ENVIRONMENT_WHEEL_CHANGED','依赖文件与固定SHA256不符。');
          const copied=path.join(wheelRoot,path.basename(wheel.path));await fsp.writeFile(copied,actual.bytes,{flag:'wx',mode:0o400});wheels.push({path:copied,sha256:wheel.sha256});
        }
        const metadata=await prepare({directory:environmentRoot,wheels,signal:entry.controller.signal,beforeLaunch:assertAuthorized,
          onLaunch:async()=>{entry.process={pid:null,stopConfirmed:false,launchPending:true};await change(projectId,job.id,owner,{process:entry.process});},
          timeoutMs:job.configuration.timeoutMs,maxOutputBytes:job.configuration.maxOutputBytes,
          onProcess:async state=>{entry.process=state;await change(projectId,job.id,owner,{process:state});},
          onOutput:({stream,text})=>{entry.logs||={stdout:'',stderr:''};entry.logs[stream]=(entry.logs[stream]+text).slice(-20000);}});
        await assertAuthorized();const content=await treeDigest(environmentRoot);
        const interpreterRealPath=await fsp.realpath(path.join(environmentRoot,'bin','python'));
        const interpreterSha256=(await regular(interpreterRealPath)).sha256;
        const environment={id:job.id,...metadata,...content,interpreterRealPath,interpreterSha256,lockSha256:job.configurationSha256,resources:{timeoutMs:job.configuration.timeoutMs,maxOutputBytes:job.configuration.maxOutputBytes,maxDiskBytes:256*1024*1024,cpuMemoryLimitEnforced:false}};
        await change(projectId,job.id,owner,{status:'ready',environment,relativeRoot:path.relative(root.control,environmentRoot),finishedAt:at(),logs:entry.logs||{stdout:'',stderr:''}},{beforePublish:assertAuthorized});
      }catch(e){await change(projectId,job.id,owner,{status:entry.controller.signal.aborted?'cancelled':'failed',error:{code:e.code||'ENVIRONMENT_PREPARATION_FAILED',message:e.message},logs:entry.logs||{stdout:'',stderr:''},finishedAt:at()});}
      finally{signal?.removeEventListener('abort',abort);if(!entry.process||entry.process.stopConfirmed){owner.release({stopConfirmed:true});active.delete(job.id);}}
    })();entry.promise.catch(()=>{});return view(projectId,await raw(projectId,job.id));
  }
  async function get(projectId,id){const job=await raw(projectId,id);const current=active.get(id);if(finished(job)&&current?.promise)await current.promise;return view(projectId,await raw(projectId,id));}
  async function verify(projectId,id,expectedSha256) {
    const job=await get(projectId,id);if(job.status!=='ready'||!job.environment||expectedSha256&&job.environment.sha256!==expectedSha256)fail('ENVIRONMENT_NOT_READY','环境尚未准备完成或固定版本已改变。');
    const root=await locations(projectId);const target=safeJoin(root.control,job.relativeRoot);
    if(!target.startsWith(path.join(root.control,job.id)+path.sep))fail('ENVIRONMENT_STORAGE_INVALID','环境目录不属于这个任务。');
    const actual=await treeDigest(target);if(actual.sha256!==job.environment.sha256)fail('ENVIRONMENT_CONTENT_CHANGED','环境文件与已准备版本不符，请重新准备。');
    const interpreter=path.join(target,'bin','python');
    const realInterpreter=await fsp.realpath(interpreter);
    if(realInterpreter!==job.environment.interpreterRealPath||(await regular(realInterpreter)).sha256!==job.environment.interpreterSha256)fail('ENVIRONMENT_INTERPRETER_CHANGED','解释器与准备时的固定版本不符。');
    return {environment:job.environment,interpreter,root:target};
  }
  return {
    async listJobs(projectId){return Promise.all((await read(projectId)).jobs.map(j=>view(projectId,j)));},
    async list(projectId){const doc=await read(projectId);return {jobs:await Promise.all(doc.jobs.map(j=>view(projectId,j))),capability:{local:await probe(),container:{available:false,reason:'尚未配置容器执行器'},remote:{available:false,reason:'尚未配置远程执行器'}}};},
    get, verify,
    async prepareAuthorized(projectId,input,{authorization,assertAuthorized,signal,onPrepared,jobId}={}) {
      if(authorization?.capability!=='environment.prepare'||authorization.actor!=='system'||authorization.projectId!==projectId||typeof assertAuthorized!=='function'||typeof onPrepared!=='function')fail('ENVIRONMENT_AUTHORIZATION_REQUIRED','自动准备环境需要原研究任务的固定授权。',403);
      signal?.throwIfAborted();await assertAuthorized();
      const validated=validateEnvironmentConfiguration(input);
      if(hash(JSON.stringify({packages:validated.packages}))!==hash(JSON.stringify(authorization.proposal))||validated.timeoutMs!==authorization.scope?.maxPrepareMs||validated.maxOutputBytes!==authorization.scope?.maxOutputBytes)fail('ENVIRONMENT_AUTHORIZATION_CHANGED','准备输入与原授权不符。',403);
      const configuration={version:1,...validated,authority:'system',authorization:structuredClone(authorization)},configurationSha256=hash(JSON.stringify(configuration));
      await constraintsFor(projectId,configuration);const root=await locations(projectId,{create:true});
      const sha=configurationSha256,id=`environment-${sha.slice(0,8)}-${sha.slice(8,12)}-4${sha.slice(13,16)}-8${sha.slice(17,20)}-${sha.slice(20,32)}`;
      // A fixed human-prepared version can satisfy the lock without another
      // installation. The research grant owns the selection, not its history.
      const existingJobs=(await read(projectId)).jobs;
      const bound=jobId?await raw(projectId,jobId):existingJobs.find(j=>j.id===id);
      if(bound&&bound.configuration.authority!=='system'){
        if(bound.status!=='ready'||JSON.stringify(bound.configuration.packages)!==JSON.stringify(validated.packages))fail('ENVIRONMENT_CONFIG_CHANGED','已绑定的原环境不再满足固定依赖配置。');
        const checked=await verify(projectId,bound.id);await onPrepared(structuredClone(bound));await assertAuthorized();return {job:{...bound,cached:true},environment:checked.environment};
      }
      if(bound&&bound.id!==id)fail('ENVIRONMENT_CONFIG_CHANGED','已绑定的环境任务不属于这个授权。');
      for(const candidate of !bound?existingJobs.filter(j=>j.status==='ready'&&j.configuration.authority!=='system'&&JSON.stringify(j.configuration.packages)===JSON.stringify(validated.packages)):[]){
        const checked=await verify(projectId,candidate.id);
        const configured=process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
        if(configured&&await fsp.realpath(configured)===checked.environment.interpreterRealPath){await onPrepared(structuredClone(candidate));await assertAuthorized();return {job:{...candidate,cached:true},environment:checked.environment};}
      }
      for(const previous of (await read(projectId)).jobs)if(!finished(previous)||previous.process?.stopConfirmed===false)assertStopped(previous);
      const owner=claimAutomationOwner({projectRoot:root.control,sessionId:id});let launched=false;
      try {
        let job=(await read(projectId)).jobs.find(j=>j.id===id);
        if(job&&job.configurationSha256!==configurationSha256)fail('ENVIRONMENT_CONFIG_CHANGED','原环境任务配置发生变化。');
        if(!job){job={id,projectId,status:'queued',configuration,configurationSha256,attempt:0,createdAt:at(),updatedAt:at()};await update(projectId,owner,doc=>{if(doc.jobs.length>=500)fail('ENVIRONMENT_STORAGE_LIMIT','环境任务达到上限。');doc.jobs.push(job);return job;},{beforePublish:assertAuthorized});}
        await onPrepared(structuredClone(job));signal?.throwIfAborted();await assertAuthorized();
        if(job.status==='ready'){const checked=await verify(projectId,id);await assertAuthorized();return {job:{...job,cached:true},environment:checked.environment};}
        assertStopped(job);launched=true;await launch(projectId,job,owner,{assertAuthorized,signal});await active.get(id)?.promise;
        const completed=await get(projectId,id);if(completed.status!=='ready')fail(completed.error?.code||'ENVIRONMENT_PREPARATION_FAILED',completed.error?.message||'环境准备未完成。');
        await assertAuthorized();return {job:completed,environment:(await verify(projectId,id)).environment};
      }finally{if(!launched)owner.release({stopConfirmed:true});}
    },
    async create(projectId,input={}){const configuration={version:1,...validateEnvironmentConfiguration(input)};await constraintsFor(projectId,configuration);
      const configurationSha256=hash(JSON.stringify(configuration)),root=await locations(projectId,{create:true});
      for(const previous of (await read(projectId)).jobs)if(!finished(previous)||previous.process?.stopConfirmed===false)assertStopped(previous);
      const id=`environment-${randomUUID()}`,owner=claimAutomationOwner({projectRoot:root.control,sessionId:id});
      try{const existing=(await read(projectId)).jobs.find(j=>j.configurationSha256===configurationSha256&&j.status==='ready');if(existing){await verify(projectId,existing.id);owner.release({stopConfirmed:true});return {...existing,cached:true};}
        const job={id,projectId,status:'queued',configuration,configurationSha256,attempt:0,createdAt:at(),updatedAt:at()};await update(projectId,owner,doc=>{if(doc.jobs.length>=500)fail('ENVIRONMENT_STORAGE_LIMIT','环境任务达到上限。');doc.jobs.push(job);return job;});return await launch(projectId,job,owner);
      }catch(e){if(!active.has(id))owner.release({stopConfirmed:true});throw e;}
    },
    async retry(projectId,id){const job=await get(projectId,id);if(job.configuration.authority==='system')fail('ENVIRONMENT_AUTOMATION_OWNED','自动环境任务需要从原研究链路继续。');if(!['failed','cancelled','interrupted'].includes(job.status))fail('ENVIRONMENT_NOT_RETRYABLE','只能继续失败、取消或中断的环境准备。');
      assertStopped(job);
      await constraintsFor(projectId,job.configuration);const root=await locations(projectId),owner=claimAutomationOwner({projectRoot:root.control,sessionId:id});try{return await launch(projectId,job,owner);}catch(e){if(!active.has(id))owner.release({stopConfirmed:true});throw e;}
    },
    async cancel(projectId,id){const job=await get(projectId,id);if(finished(job))return job;const entry=active.get(id);if(!entry)fail('ENVIRONMENT_STOP_UNCONFIRMED','请先确认原准备进程已停止再继续。');entry.controller.abort(new Error('环境准备已取消。'));await entry.promise;return get(projectId,id);},
    async shutdown(){const entries=[...active.values()];for(const e of entries)e.controller.abort(new Error('服务正在停止。'));await Promise.allSettled(entries.map(e=>e.promise));}
  };
}
export const environmentService=createEnvironmentService();
