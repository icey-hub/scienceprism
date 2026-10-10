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
