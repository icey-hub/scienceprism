import { getProjectExploration } from '../services/projectHub/exploration.js';
import { getToolCatalogue } from '../services/projectHub/toolCatalogue.js';
export function registerExplorationRoutes(fastify) {
  fastify.get('/api/projects/:id/tool-catalogue', async(req,reply)=>{try{return {ok:true,...await getToolCatalogue(req.params.id)};}catch(error){return reply.code(error.statusCode||500).send({ok:false,error:{code:error.code||'TOOL_CATALOGUE_ERROR',message:error.message}});}});
  fastify.get('/api/projects/:id/exploration', async (req,reply) => {
    try { return {ok:true,graph:await getProjectExploration(req.params.id,req.query || {})}; }
    catch(error) { return reply.code(error.statusCode || 500).send({ok:false,error:{code:error.code || 'EXPLORATION_ERROR',message:error.message}}); }
  });
}
