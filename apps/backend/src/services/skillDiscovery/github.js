import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { assertNetworkHost } from '../harnessRuntime/capabilities.js';
import { isPublicAddress, parseDownloadProxy } from '../paperAttachments/download.js';

export const GITHUB_HOSTS = Object.freeze(['api.github.com', 'raw.githubusercontent.com']);
export const MAX_DOCUMENT_BYTES = 128_000;
export class SkillDiscoveryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message); this.name = 'SkillDiscoveryError'; this.code = code; this.statusCode = statusCode;
  }
}
export const invalid = message => new SkillDiscoveryError('SKILL_DISCOVERY_INVALID_INPUT', message);
const upstream = message => new SkillDiscoveryError('SKILL_DISCOVERY_UPSTREAM', message, 502);
const SHA = /^[a-f0-9]{40}$/;
const publicResponses = new Map();
const CACHE_BYTES = 32 * 1024 * 1024;
const runFile = promisify(execFile);
const authConfiguration = () => new SkillDiscoveryError('SKILL_DISCOVERY_AUTH_CONFIGURATION',
  'GitHub 凭据配置无效。请检查后端的 Token、私有凭据文件或 GitHub CLI 登录配置。', 503);
function validateToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,255}$/.test(value.trim())) throw authConfiguration();
  return value.trim();
}
export async function readGithubToken(env = process.env, { run = runFile, signal } = {}) {
  if (env.SCIENCEPRISM_GITHUB_TOKEN) return validateToken(env.SCIENCEPRISM_GITHUB_TOKEN);
  if (!env.SCIENCEPRISM_GITHUB_TOKEN_FILE) {
    if (!env.SCIENCEPRISM_GITHUB_CLI && !env.SCIENCEPRISM_GITHUB_CLI_CONFIG_DIR) return '';
    const executable = env.SCIENCEPRISM_GITHUB_CLI; const config = env.SCIENCEPRISM_GITHUB_CLI_CONFIG_DIR;
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || typeof config !== 'string' || !path.isAbsolute(config)) throw authConfiguration();
    // No shell or ambient GH_TOKEN; only the explicitly configured CLI account is used.
    const cliEnv = { GH_CONFIG_DIR: config, GH_CACHE_DIR: path.join(config, 'cache'), GH_NO_UPDATE_NOTIFIER: '1' };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot']) if (env[key]) cliEnv[key] = env[key];
    try {
      const { stdout } = await run(executable, ['auth', 'token', '--hostname', 'github.com'], {
        env: cliEnv, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true, signal
      });
      return validateToken(stdout);
    } catch { throw authConfiguration(); }
  }
  let file;
  try {
    file = await open(env.SCIENCEPRISM_GITHUB_TOKEN_FILE, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw authConfiguration();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw authConfiguration();
    return validateToken(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { throw authConfiguration(); }
  finally { await file?.close(); }
}
function cacheLifetime(url) {
  if (url.hostname === 'raw.githubusercontent.com' && /^\/[^/]+\/[^/]+\/[a-f0-9]{40}\//.test(url.pathname)) return 60 * 60_000;
  if (/\/(?:commits|git\/trees)\/[a-f0-9]{40}$/.test(url.pathname)) return 60 * 60_000;
  return 30_000;
}
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
export function parseGithubProxy(value) {
  try { return parseDownloadProxy(value); }
  catch { throw new SkillDiscoveryError('SKILL_DISCOVERY_PROXY_CONFIGURATION', 'Skill 发现代理必须是有效的 HTTP/HTTPS 代理 URL。', 503); }
}
export function isSafeRepositoryPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
export function normalizeRepository(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['repository', 'ref', 'path'].includes(key))) throw invalid('仓库参数无效。');
  let repository = input.repository;
  if (typeof repository !== 'string') throw invalid('请提供 owner/repo 或 GitHub 仓库 URL。');
  if (repository.startsWith('https://')) {
    let url; try { url = new URL(repository); } catch { /* Validated below. */ }
    if (!url || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw invalid('仅支持公开 GitHub 仓库 URL。');
    repository = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  repository = repository.replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(repository)
    || ['.', '..'].includes(repository.split('/')[1])) throw invalid('仓库必须使用 owner/repo 格式；分支和子目录请单独指定。');
  const ref = input.ref ?? 'HEAD';
  if (typeof ref !== 'string' || !ref || ref.length > 200 || /[\x00-\x20\x7f?#\\]/.test(ref) || ref === '.' || ref === '..') throw invalid('仓库 ref 无效。');
  const subpath = input.path ?? '';
  if (subpath !== '' && !isSafeRepositoryPath(subpath)) throw invalid('仓库子目录无效。');
  return { repository: repository.toLowerCase(), ref, path: subpath };
}

function aborted(signal) {
  return new SkillDiscoveryError(signal?.reason?.name === 'TimeoutError' ? 'SKILL_DISCOVERY_TIMEOUT' : 'SKILL_DISCOVERY_CANCELLED',
    signal?.reason?.name === 'TimeoutError' ? 'Skill 目录请求超时。' : 'Skill 目录请求已取消。', signal?.reason?.name === 'TimeoutError' ? 504 : 499);
}
export function abortable(operation, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  if (!signal) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted(signal));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Direct connections pin checked public DNS. An explicitly configured trusted
 * CONNECT proxy resolves the allowed host instead; no ambient proxy fallback. */
export function createGithubTransport({ lookup = dnsLookup, request = https.request, timeoutMs = 10_000,
  proxyUrl = () => process.env.SCIENCEPRISM_SKILL_DISCOVERY_PROXY,
  token = ({ signal } = {}) => readGithubToken(process.env, { signal }),
  cache = request === https.request ? publicResponses : null, now = Date.now } = {}) {
  return async function get(value, { maxBytes = MAX_DOCUMENT_BYTES, signal, capabilityPolicy, cacheResponse = true } = {}) {
    let url; try { url = new URL(value); } catch { /* Validated below. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !GITHUB_HOSTS.includes(url.hostname)) {
      throw new SkillDiscoveryError('SKILL_DISCOVERY_HOST_DENIED', 'Skill 发现仅允许 GitHub API 与固定提交的 raw 内容。', 403);
    }
    assertNetworkHost(capabilityPolicy ?? { granted: ['research.search'], networkAllowlist: GITHUB_HOSTS }, url.href);
    if (signal?.aborted) throw aborted(signal);
    // Credentials belong only to the GitHub API origin, never raw files or CONNECT headers.
    const credential = url.hostname === 'api.github.com' ? await abortable(() => typeof token === 'function' ? token({ signal }) : token, signal) : '';
    const authorization = credential ? validateToken(credential) : '';
    const identity = authorization ? createHash('sha256').update(authorization).digest('hex') : 'anonymous';
    const cacheKey = `${identity}:${url.href}`;
    const cached = cacheResponse && cache?.get(cacheKey);
    if (cached && cached.expires > now()) {
      if (cached.bytes.length > maxBytes) throw new SkillDiscoveryError('SKILL_DISCOVERY_TOO_LARGE', 'GitHub 响应超过读取上限。', 422);
      return Buffer.from(cached.bytes);
    }
    cache?.delete(cacheKey);
    const proxy = parseGithubProxy(typeof proxyUrl === 'function' ? proxyUrl() : proxyUrl);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
    let response; let agent;
    try {
      return await abortable(async () => {
        let address;
        if (proxy) {
          const headers = {};
          if (proxy.username || proxy.password) {
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
            proxy.username = ''; proxy.password = '';
          }
          agent = new HttpsProxyAgent(proxy, { headers, signal: combined, rejectUnauthorized: true });
        } else {
          const addresses = await abortable(() => lookup(url.hostname, { all: true, verbatim: true }), combined);
          if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
            throw new SkillDiscoveryError('SKILL_DISCOVERY_HOST_DENIED', 'GitHub 主机解析到非公开地址。', 403);
          }
          address = addresses.find(item => item.family === 4) || addresses[0];
        }
        response = await new Promise((resolve, reject) => {
          const req = request(url, { method: 'GET', agent: agent || false, rejectUnauthorized: true, signal: combined,
            ...(!agent ? { lookup: (_host, options, done) => options.all ? done(null, [address]) : done(null, address.address, address.family) } : {}),
            headers: { Accept: url.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'text/plain',
              ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
              'User-Agent': 'SciencePrism-Skill-Discovery/1.0', 'Accept-Encoding': 'identity', 'X-GitHub-Api-Version': '2022-11-28' }
          }, resolve);
          req.on('error', reject); req.end();
        });
        if (combined.aborted) throw aborted(combined);
        if (response.statusCode >= 300 && response.statusCode < 400) throw upstream('GitHub 重定向已拒绝，请提供仓库当前地址。');
        if (response.statusCode === 401) throw new SkillDiscoveryError('SKILL_DISCOVERY_AUTH_INVALID', 'GitHub 认证失败，请在后端更新已过期、撤销或无效的 Token。', 503);
        let secondaryLimit = false;
        if (response.statusCode === 403 && String(response.headers['x-ratelimit-remaining']) !== '0' && !response.headers['retry-after']) {
          // Some secondary limits have only an error message, without rate-limit headers.
          const parts = []; let length = 0;
          for await (const chunk of response) {
            if (combined.aborted) throw aborted(combined);
            const part = Buffer.from(chunk); length += part.length;
            if (length > 16_384) break;
            parts.push(part);
          }
          if (length <= 16_384) {
            let message;
            try { message = JSON.parse(Buffer.concat(parts).toString('utf8')).message; } catch { /* Never expose the upstream body. */ }
            secondaryLimit = typeof message === 'string' && /secondary rate limit|abuse detection/i.test(message);
          }
        }
        if (response.statusCode === 429 || (response.statusCode === 403
          && (secondaryLimit || String(response.headers['x-ratelimit-remaining']) === '0' || response.headers['retry-after']))) {
          const reset = Number(response.headers['x-ratelimit-reset']);
          const limitKnown = String(response.headers['x-ratelimit-remaining']) === '0' && Number.isFinite(reset) && reset * 1000 > now();
          const retryAfter = Number(response.headers['retry-after']);
          const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter)
            : limitKnown ? Math.ceil((reset * 1000 - now()) / 1000) : 60;
          throw new SkillDiscoveryError('SKILL_DISCOVERY_RATE_LIMITED', limitKnown
            ? `GitHub ${authorization ? '认证' : '匿名'}接口额度已用尽，约 ${Math.ceil((reset * 1000 - now()) / 60_000)} 分钟后可重试。`
            : `GitHub 请求受限，请至少等待 ${waitSeconds} 秒后重试。`, 429);
        }
        if (response.statusCode === 403) throw new SkillDiscoveryError('SKILL_DISCOVERY_ACCESS_DENIED', 'GitHub 拒绝访问，请检查 Token 权限、组织访问策略或稍后重试（二级限流）。', 403);
        if (response.statusCode !== 200) throw upstream(response.statusCode === 404 ? '公开仓库、提交或文件不存在。' : 'GitHub 未能返回 Skill 文件。');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw upstream('GitHub 返回了不支持的内容编码。');
        if (Number(response.headers['content-length']) > maxBytes) throw new SkillDiscoveryError('SKILL_DISCOVERY_TOO_LARGE', 'GitHub 响应超过读取上限。', 422);
        const chunks = []; let bytes = 0;
        for await (const chunk of response) {
          if (combined.aborted) throw aborted(combined);
          const part = Buffer.from(chunk); bytes += part.length;
          if (bytes > maxBytes) throw new SkillDiscoveryError('SKILL_DISCOVERY_TOO_LARGE', 'GitHub 响应超过读取上限。', 422);
          chunks.push(part);
        }
        const payload = Buffer.concat(chunks);
        if (cache && cacheResponse) {
          cache.set(cacheKey, { bytes: Buffer.from(payload), expires: now() + cacheLifetime(url) });
          let total = [...cache.values()].reduce((size, item) => size + item.bytes.length, 0);
          while (cache.size > 128 || total > CACHE_BYTES) {
            const key = cache.keys().next().value; total -= cache.get(key).bytes.length; cache.delete(key);
          }
        }
        return payload;
      }, combined);
    } catch (error) {
      if (combined.aborted) throw aborted(combined);
      if (error.statusCode) throw error;
      throw upstream('无法连接公开 GitHub 目录。');
    } finally { clearTimeout(timer); controller.abort(); response?.destroy(); agent?.destroy(); }
  };
}

export function createGithubSkillSource({ transport = createGithubTransport(), maxRequests = 32 } = {}) {
  return function session({ signal, capabilityPolicy } = {}) {
    let requests = 0;
    const get = async (url, maxBytes, cacheResponse = true) => {
      if (++requests > maxRequests) throw new SkillDiscoveryError('SKILL_DISCOVERY_REQUEST_LIMIT', '本次目录读取达到请求上限，请缩小范围。', 422);
      return abortable(() => transport(url, { maxBytes, signal, capabilityPolicy, cacheResponse }), signal);
    };
    const json = async (url, cacheResponse = true) => {
      const bytes = await get(url, 4 * 1024 * 1024, cacheResponse);
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw upstream('GitHub 目录响应不是有效 JSON。'); }
    };
    return {
      get requestCount() { return requests; },
      async resolve(input) {
        const source = normalizeRepository(input);
        const base = `https://api.github.com/repos/${source.repository}`;
        // Recheck visibility before using cached commits, including after a repo becomes private.
        const repository = await json(base, false);
        if (repository?.private !== false || (repository.visibility !== undefined && repository.visibility !== 'public')) {
          throw new SkillDiscoveryError('SKILL_DISCOVERY_PUBLIC_ONLY', 'Skill 发现与安装仅支持公开 GitHub 仓库。', 403);
        }
        const commit = await json(`${base}/commits/${encodeURIComponent(source.ref)}`);
        if (!SHA.test(commit?.sha) || !SHA.test(commit?.commit?.tree?.sha)
          || (SHA.test(source.ref) && source.ref !== commit.sha)) throw upstream('GitHub 未返回可核验的固定提交。');
        const tree = await json(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`);
        if (tree?.sha !== commit.commit.tree.sha || !Array.isArray(tree.tree) || tree.tree.length > 30_000) throw upstream('GitHub 文件树格式或大小无效。');
        if (tree.truncated !== false) throw new SkillDiscoveryError('SKILL_DISCOVERY_TREE_TRUNCATED', '仓库文件树不完整；请使用更小的 Skill 仓库。', 422);
        if (tree.tree.some(item => !isSafeRepositoryPath(item.path))) throw upstream('GitHub 文件树包含无效路径。');
        const files = tree.tree.filter(item => item.type === 'blob' && ['100644', '100755'].includes(item.mode));
        if (files.some(item => !SHA.test(item.sha) || !Number.isSafeInteger(item.size) || item.size < 0)) throw upstream('GitHub 文件元数据无效。');
        const byPath = new Map(files.map(item => [item.path, item]));
        const cached = new Map();
        const snapshot = { ...source, commit: commit.sha, files,
          unsafeEntries: tree.tree.filter(item => item.mode === '120000' || item.mode === '160000').map(item => ({ path: item.path, mode: item.mode })),
          skippedLinks: tree.tree.filter(item => item.mode === '120000' || item.mode === '160000').length,
          url: `https://github.com/${source.repository}/tree/${commit.sha}${source.path ? `/${encodePath(source.path)}` : ''}` };
        const readBytes = async (file, { maxBytes = MAX_DOCUMENT_BYTES } = {}) => {
            const entry = byPath.get(file);
            if (!entry) throw upstream('固定提交中不存在此普通文件。');
            if (entry.size > maxBytes) throw new SkillDiscoveryError('SKILL_DISCOVERY_TOO_LARGE', 'Skill 文件超过读取上限。', 422);
            if (cached.has(file)) return cached.get(file);
            const bytes = await get(`https://raw.githubusercontent.com/${source.repository}/${commit.sha}/${encodePath(file)}`, maxBytes);
            const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
            if (bytes.length !== entry.size || blob !== entry.sha) throw upstream('文件摘要与固定提交不一致。');
            const result = { path: file, bytes, digest: createHash('sha256').update(bytes).digest('hex'),
              url: `https://github.com/${source.repository}/blob/${commit.sha}/${encodePath(file)}` };
            cached.set(file, result); return result;
        };
        return { ...snapshot, readBytes,
          async read(file) {
            const result = await readBytes(file);
            let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes); } catch { throw upstream('Skill 元数据不是 UTF-8 文本。'); }
            return { path: result.path, content, digest: result.digest, url: result.url };
          }
        };
      }
    };
  };
}
