import {getMcpCatalogue,saveMcpServer,deleteMcpServer,discoverMcpTools} from '../services/mcp/index.js';
import { createHarnessRun, startHarnessRun } from '../services/harnessRuntime/index.js';
export function registerMcpRoutes(fastify){
 const route=fn=>async(req,reply)=>{try{return {ok:true,...await fn(req)};}catch(error){return reply.code(error.statusCode||500).send({ok:false,error:{code:error.code||'MCP_ERROR',message:error.statusCode?error.message:'MCP operation failed.'}});}};
 fastify.post('/api/projects/:id/mcp/:server/check',route(async req=>{
   const run=await createHarnessRun(req.params.id,{adapter:'mcp',role:'project-agent',task:'mcp-check',capabilities:['project.read'],fallback:false,prompt:'Explicit read-only MCP tool check',mcpCall:{serverId:req.params.server,toolName:req.body?.toolName,arguments:req.body?.arguments||{}}});
   await startHarnessRun(req.params.id,run.id);return {run};
 }));
 fastify.get('/api/projects/:id/mcp',route(req=>getMcpCatalogue(req.params.id)));
 fastify.put('/api/projects/:id/mcp/:server',route(req=>saveMcpServer(req.params.id,{...req.body,id:req.params.server})));
 fastify.delete('/api/projects/:id/mcp/:server',route(req=>deleteMcpServer(req.params.id,req.params.server)));
 fastify.post('/api/projects/:id/mcp/:server/discover',route(req=>discoverMcpTools(req.params.id,req.params.server)));
}
