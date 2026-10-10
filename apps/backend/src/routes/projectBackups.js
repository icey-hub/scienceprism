import { exportProjectBackup, restoreProjectBackup } from '../services/projectBackup.js';
import { isLocalAddress } from '../utils/authUtils.js';
import { TUNNEL_MODE } from '../config/constants.js';

function route(handler) {
  return async (req, reply) => {
    if (!isLocalAddress(req.ip) || !['false', '0', 'no'].includes(TUNNEL_MODE.toLowerCase().trim())) {
      return reply.code(403).send({ ok: false, error: { code: 'LOCAL_BACKUP_REQUIRED', message: 'Open SciencePrism on this computer with the tunnel disabled to back up or restore projects.' } });
    }
    try { return await handler(req, reply); }
    catch (error) {
      if (!error.statusCode) req.log.error(error);
      return reply.code(error.statusCode || 500).send({ ok: false, error: { code: error.statusCode ? error.code || 'INVALID_BACKUP' : 'BACKUP_STORAGE_ERROR', message: error.statusCode ? error.message : 'Backup storage failed. Your existing projects have not been replaced.' } });
    }
  };
}
export function registerProjectBackupRoutes(fastify) {
  fastify.get('/api/projects/:id/backup', route(async (req, reply) => {
    const backup = await exportProjectBackup(req.params.id);
    reply.header('content-disposition', `attachment; filename="scienceprism-${encodeURIComponent(req.params.id)}.json"`);
    return reply.send(backup);
  }));
  fastify.post('/api/projects/restore-backup', { bodyLimit: 90 * 1024 * 1024 }, route(async (req, reply) => {
    const project = await restoreProjectBackup(req.body);
    return reply.code(201).send({ ok: true, project });
  }));
}
