import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export function getEnv(name) {
  return process.env[`SCIENCEPRISM_${name}`] ?? process.env[`OPENPRISM_${name}`];
}

export const DATA_DIR = getEnv('DATA_DIR') || path.join(REPO_ROOT, 'data');
export const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates');
export const TEMPLATE_MANIFEST = path.join(TEMPLATE_DIR, 'manifest.json');
export const PORT = Number(process.env.PORT || 8787);
export const COLLAB_TOKEN_SECRET = getEnv('COLLAB_TOKEN_SECRET') || 'scienceprism-collab-dev';
export const COLLAB_TOKEN_TTL = Number(getEnv('COLLAB_TOKEN_TTL') || 24 * 60 * 60);
const requireTokenEnv = getEnv('COLLAB_REQUIRE_TOKEN');
export const COLLAB_REQUIRE_TOKEN = requireTokenEnv
  ? !['0', 'false', 'no'].includes(String(requireTokenEnv).toLowerCase())
  : true;
export const COLLAB_FLUSH_DEBOUNCE_MS = Number(getEnv('COLLAB_FLUSH_DEBOUNCE_MS') || 800);
export const TUNNEL_MODE = getEnv('TUNNEL') || 'false';

// MinerU API
export const MINERU_API_BASE = 'https://mineru.net/api/v4';
export const MINERU_POLL_INTERVAL_MS = 3000;
export const MINERU_MAX_POLL_ATTEMPTS = 200;
