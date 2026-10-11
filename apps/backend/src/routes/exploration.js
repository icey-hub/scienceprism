import { getProjectExploration } from '../services/projectHub/exploration.js';
export function registerExplorationRoutes(fastify) {
  fastify.get('/api/projects/:id/exploration', async (req,reply) => {
    try { return {ok:true,graph:await getProjectExploration(req.params.id,req.query || {})}; }
    catch(error) { return reply.code(error.statusCode || 500).send({ok:false,error:{code:error.code || 'EXPLORATION_ERROR',message:error.message}}); }
  });
}
