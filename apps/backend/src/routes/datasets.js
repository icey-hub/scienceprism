import { datasetService, DatasetError } from '../services/datasets/index.js';
import { MAX_DATASET_BYTES } from '../services/datasets/download.js';
const base='/api/projects/:id/datasets';
function error(reply,cause){
  if(cause?.code==='FST_REQ_FILE_TOO_LARGE')cause=new DatasetError('DATASET_TOO_LARGE','文件超过128MiB上限。',413);
  else if(['FST_FIELDS_LIMIT','FST_FILES_LIMIT','FST_PARTS_LIMIT','FST_INVALID_MULTIPART_CONTENT_TYPE'].includes(cause?.code))cause=new DatasetError('DATASET_INVALID_INPUT','导入只允许一个文件，不接受附加字段。');
  return reply.code(cause instanceof DatasetError?cause.statusCode:500).send({ok:false,error:{code:cause instanceof DatasetError?cause.code:'DATASET_REQUEST_FAILED',message:cause instanceof DatasetError?cause.message:'数据请求失败，请保留已有文件后重试。'}});
}
function bodyObject(body){
  if(body===undefined)return {};
  if(!body||typeof body!=='object'||Array.isArray(body))throw new DatasetError('DATASET_INVALID_INPUT','请求参数必须为对象。');
  return body;
}
export function registerDatasetRoutes(app,{service=datasetService}={}){
  app.get(base,async(req,reply)=>{try{return {ok:true,...await service.list(req.params.id)};}catch(cause){return error(reply,cause);}});
  app.post(`${base}/import`,async(req,reply)=>{try{
    let input;
    for await(const part of req.parts({limits:{files:1,fileSize:MAX_DATASET_BYTES,fields:0,parts:1}})){
      if(part.type!=='file'||input)throw new DatasetError('DATASET_INVALID_INPUT','导入只允许一个文件。');
      const bytes=await part.toBuffer();if(part.file.truncated)throw new DatasetError('DATASET_TOO_LARGE','文件超过128MiB上限。',413);
      input={filename:part.filename,bytes};
    }
    if(!input)throw new DatasetError('DATASET_FILE_REQUIRED','请选择本地数据文件。');
    return reply.code(201).send({ok:true,...await service.importData(req.params.id,input)});
  }catch(cause){return error(reply,cause);}});
  app.post(`${base}/download`,async(req,reply)=>{try{const result=await service.startDownload(req.params.id,req.body??{});return reply.code(result.cached?200:202).send({ok:true,...result});}catch(cause){return error(reply,cause);}});
  app.get(`${base}/jobs/:jobId`,async(req,reply)=>{try{return {ok:true,job:await service.getJob(req.params.id,req.params.jobId)};}catch(cause){return error(reply,cause);}});
  app.post(`${base}/jobs/:jobId/resume`,async(req,reply)=>{try{const body=bodyObject(req.body);if(Object.keys(body).some(key=>key!=='expectedConfigurationVersion'))throw new DatasetError('DATASET_INVALID_INPUT','继续任务不能更换来源、文件名或预算。');return {ok:true,...await service.resume(req.params.id,req.params.jobId,body)};}catch(cause){return error(reply,cause);}});
  app.post(`${base}/jobs/:jobId/cancel`,async(req,reply)=>{try{if(Object.keys(bodyObject(req.body)).length)throw new DatasetError('DATASET_INVALID_INPUT','取消任务不接受附加参数。');return {ok:true,job:await service.cancel(req.params.id,req.params.jobId)};}catch(cause){return error(reply,cause);}});
  app.get(`${base}/:datasetId`,async(req,reply)=>{try{return {ok:true,dataset:await service.get(req.params.id,req.params.datasetId)};}catch(cause){return error(reply,cause);}});
  app.get(`${base}/:datasetId/content`,async(req,reply)=>{try{const {dataset,bytes}=await service.content(req.params.id,req.params.datasetId);return reply.header('Content-Type','application/octet-stream').header('X-Content-Type-Options','nosniff').header('Cache-Control','private, no-cache').header('ETag',`"${dataset.sha256}"`).header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(dataset.filename)}`).send(bytes);}catch(cause){return error(reply,cause);}});
}
