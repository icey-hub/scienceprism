import { readingOcrService } from '../services/readingOcr/index.js';

export function registerReadingOcrRoutes(app, { service = readingOcrService } = {}) {
  const base='/api/projects/:id/papers/:paperId/ocr';
  const ids=req=>[req.params.id,req.params.paperId];
  const route=(action,writing=false)=>async(req,reply)=>{
    const controller=new AbortController(),disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};
    reply.raw.on('close',disconnect);
    try{
      if(writing&&(req.headers['x-scienceprism-actor']||req.headers['x-openprism-actor'])!=='human')return reply.code(403).send({ok:false,error:{code:'OCR_HUMAN_REQUIRED',message:'请在阅读器中明确选择识别、纠正或翻译。'}});
      return{ok:true,...await action(req,controller.signal)};
    }catch(error){if(controller.signal.aborted)return;const status=Number.isInteger(error.statusCode)?error.statusCode:500;if(status>=500)req.log?.error?.(error);return reply.code(status).send({ok:false,error:{code:error.code||'OCR_ERROR',message:error.statusCode?error.message:'OCR暂不可用，已有记录保留。'}});}
    finally{reply.raw.off('close',disconnect);}
  };
  app.get(base,route(req=>service.list(...ids(req))));
  app.post(base,{bodyLimit:8*1024},route(req=>service.start(...ids(req),req.body),true));
  app.get(`${base}/:taskId`,route(req=>service.get(...ids(req),req.params.taskId)));
  app.post(`${base}/:taskId/cancel`,route(req=>service.cancel(...ids(req),req.params.taskId),true));
  app.post(`${base}/:taskId/retry`,{bodyLimit:1024},route(req=>service.retry(...ids(req),req.params.taskId,req.body),true));
  app.patch(`${base}/:taskId/correction`,{bodyLimit:64*1024},route(req=>service.correct(...ids(req),req.params.taskId,req.body),true));
  app.post(`${base}/:taskId/translate`,{bodyLimit:2048},route((req,signal)=>service.translate(...ids(req),req.params.taskId,req.body,{signal}),true));
}
