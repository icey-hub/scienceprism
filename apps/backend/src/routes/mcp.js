import {getMcpCatalogue,saveMcpServer,deleteMcpServer,discoverMcpTools} from '../services/mcp/index.js';
export function registerMcpRoutes(fastify){
 const route=fn=>async(req,reply)=>{try{return {ok:true,...await fn(req)};}catch(error){return reply.code(error.statusCode||500).send({ok:false,error:{code:error.code||'MCP_ERROR',message:error.statusCode?error.message:'MCP operation failed.'}});}};
 fastify.get('/api/projects/:id/mcp',route(req=>getMcpCatalogue(req.params.id)));
 fastify.put('/api/projects/:id/mcp/:server',route(req=>saveMcpServer(req.params.id,{...req.body,id:req.params.server})));
 fastify.delete('/api/projects/:id/mcp/:server',route(req=>deleteMcpServer(req.params.id,req.params.server)));
 fastify.post('/api/projects/:id/mcp/:server/discover',route(req=>discoverMcpTools(req.params.id,req.params.server)));
}
