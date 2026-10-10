import { verifyToken } from '../services/collab/tokenService.js';
import { COLLAB_REQUIRE_TOKEN, TUNNEL_MODE } from '../config/constants.js';

export function isLocalAddress(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip === '::ffff:127.0.0.1') return true;
  return false;
}

export function getClientIp(req) {
  // Forwarded headers are untrusted. A loopback tunnel proxy is remote access,
  // even when it omits its forwarded headers.
  const tunnelActive = !['false', '0', 'no'].includes(TUNNEL_MODE.toLowerCase().trim());
  return tunnelActive ? 'tunnel' : req.ip;
}

export function getBearerToken(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

export function getQueryToken(req) {
  const token = req.query?.token;
  if (!token) return null;
  if (Array.isArray(token)) return token[0];
  return String(token);
}

export function requireAuthIfRemote(req) {
  if (!COLLAB_REQUIRE_TOKEN) return { ok: true, payload: null };
  const clientIp = getClientIp(req);
  if (isLocalAddress(clientIp)) return { ok: true, payload: null };
  const token = getBearerToken(req) || getQueryToken(req);
  const payload = verifyToken(token);
  if (!payload) return { ok: false, payload: null };
  return { ok: true, payload };
}

export function registerApiAuth(fastify) {
  fastify.decorateRequest('collabAuth', null);
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    if (req.method === 'OPTIONS') return;
    const route = req.routeOptions.url;
    if (route === '/api/health' || route === '/api/collab' || route === '/api/collab/resolve') return;
    const auth = requireAuthIfRemote(req);
    if (!auth.ok) return reply.code(401).send({ ok: false, error: 'Unauthorized' });
    req.collabAuth = auth.payload || null;
    if (auth.payload && !canAccessProjectRequest(req, auth.payload.projectId)) {
      return reply.code(403).send({ ok: false, error: 'Project access denied' });
    }
  });
}

function canAccessProjectRequest(req, projectId) {
  const identifiers = [];
  const route = req.routeOptions.url;
  const projectRoute = route.startsWith('/api/projects/:id');
  const projectCommand = req.method === 'POST' && ['/api/compile', '/api/agent/run', '/api/plot/gpt-image-2', '/api/plot/from-table'].includes(route);
  if (projectRoute) identifiers.push(req.params.id);
  if (projectCommand) identifiers.push(req.body?.projectId);
  else if (req.body?.projectId !== undefined) identifiers.push(req.body.projectId);
  if (req.query?.projectId !== undefined) identifiers.push(req.query.projectId);
  if (identifiers.some((id) => typeof id !== 'string' || id !== projectId)) return false;
  if (projectRoute || projectCommand) return true;
  // These catalogs contain no project content. Project listing is filtered by
  // the route itself; a project invitation never grants global mutation access.
  return req.method === 'GET' && ['/api/projects', '/api/templates', '/api/agent/roles', '/api/agent/runtime'].includes(route);
}
