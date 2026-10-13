import { environmentService } from '../services/experimentRunner/environments.js';
import { ExperimentRunnerError } from '../services/experimentRunner/errors.js';

export function registerEnvironmentRoutes(app,{service=environmentService}={}) {
  const base='/api/projects/:id/environments';
  const route=handler=>async(req,reply)=>{try{return {ok:true,...await handler(req)};}catch(e){req.log?.error?.(e);return reply.code(e instanceof ExperimentRunnerError?e.statusCode:500).send({ok:false,error:{code:e.code||'ENVIRONMENT_REQUEST_FAILED',message:e instanceof ExperimentRunnerError?e.message:'环境准备请求失败。'}});}};
  const body=req=>{if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new ExperimentRunnerError(400,'ENVIRONMENT_CONFIG_INVALID','环境配置必须是对象。');return req.body;};
  const noBody=req=>{if(req.body!==undefined&&Object.keys(body(req)).length)throw new ExperimentRunnerError(400,'ENVIRONMENT_CONFIG_INVALID','继续和取消不能更换已固定的配置。');};
  app.get(base,route(req=>service.list(req.params.id)));
  app.post(base,route(async req=>({job:await service.create(req.params.id,body(req))})));
  app.get(`${base}/:jobId`,route(async req=>({job:await service.get(req.params.id,req.params.jobId)})));
  app.post(`${base}/:jobId/retry`,route(async req=>{noBody(req);return {job:await service.retry(req.params.id,req.params.jobId)};}));
  app.post(`${base}/:jobId/cancel`,route(async req=>{noBody(req);return {job:await service.cancel(req.params.id,req.params.jobId)};}));
}
