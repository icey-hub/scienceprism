import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { isPublicAddress, parseDownloadProxy } from '../paperAttachments/download.js';

export const MAX_DATASET_BYTES = 128 * 1024 * 1024;
export const SUPPORTED_DATASET_HOSTS = Object.freeze(['raw.githubusercontent.com', 'archive.ics.uci.edu', 'zenodo.org', 'huggingface.co']);
export const DATASET_HF_CDN_HOSTS = Object.freeze(['cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co', 'cas-bridge.xethub.hf.co']);
const HF_CDN_HOSTS = new Set(DATASET_HF_CDN_HOSTS);
export class DatasetError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = 'DatasetError'; this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, status = 400) => { throw new DatasetError(code, message, status); };
const strongEtag = value => typeof value === 'string' && /^"[\x21\x23-\x7e]{0,200}"$/.test(value);
function parseUrl(value, { hfRedirect = false } = {}) {
  let url; try { url = new URL(value); } catch {}
  if (typeof value !== 'string' || value.length > 8192 || !url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('DATASET_INVALID_URL', 'Use a supported public HTTPS dataset URL without credentials.');
  const cdn = hfRedirect && HF_CDN_HOSTS.has(url.hostname);
  if (!SUPPORTED_DATASET_HOSTS.includes(url.hostname) && !cdn) fail('DATASET_SOURCE_UNSUPPORTED', 'This dataset download source is not supported.', 422);
  if (!cdn && [...url.searchParams.keys()].some(key => /(?:api[_-]?key|token|password|authorization|credential|secret)/i.test(key))) fail('DATASET_INVALID_URL', 'Dataset source URLs must not contain authentication secrets.');
  if (url.hostname === 'huggingface.co') {
    if (!/^\/datasets\/(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+\/resolve\/[a-f0-9]{40}\/.+$/i.test(url.pathname)) fail('DATASET_REVISION_REQUIRED', 'Hugging Face datasets require a fixed 40-character commit revision and file path.', 422);
    let parts; try { parts = url.pathname.split('/').slice(1).map(decodeURIComponent); } catch { fail('DATASET_INVALID_URL', 'The dataset file path is invalid.'); }
    if (parts.some(part => !part || ['.', '..'].includes(part) || /[\\/\x00-\x1f\x7f]/.test(part))) fail('DATASET_INVALID_URL', 'The dataset file path must not contain encoded traversal or separators.');
  }
  return url;
}
export function parseDatasetUrl(value) { return parseUrl(value); }

function requestPinned(url, address, { signal, proxyUrl, headers }) {
  return new Promise((resolve, reject) => {
    let agent;
    if (proxyUrl) {
      const proxy = new URL(proxyUrl), proxyHeaders = {};
      if (proxy.username || proxy.password) {
        proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
        proxy.username = ''; proxy.password = '';
      }
      agent = new HttpsProxyAgent(proxy, { headers: proxyHeaders, signal, rejectUnauthorized: true });
    }
    const request = https.request(url, { method: 'GET', signal, agent: agent || false, rejectUnauthorized: true,
      headers: { Accept: 'application/octet-stream,*/*;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'SciencePrism/1.0 (public dataset download)', ...headers },
      ...(!agent ? { lookup: (_host, options, done) => options.all ? done(null, [address]) : done(null, address.address, address.family) } : {}) }, resolve);
    request.once('error', reject); request.once('close', () => agent?.destroy()); request.end();
  });
}
async function abortable(operation, signal) {
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([operation, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
function destinationFile(destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.resolve(destination) !== destination) fail('DATASET_PATH_DENIED', 'The trusted download destination must be a canonical absolute file path.');
  const parent = path.dirname(destination); let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch { fail('DATASET_PATH_DENIED', 'The trusted destination directory is unavailable.'); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) fail('DATASET_PATH_DENIED', 'The download destination cannot traverse directory links.');
  let previous;
  try { previous = fs.lstatSync(destination); } catch (reason) { if (reason.code !== 'ENOENT') fail('DATASET_PATH_DENIED', 'The download destination is unavailable.'); }
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) fail('DATASET_PATH_DENIED', 'Only a regular unlinked new or partial dataset file may be written.');
  let fd;
  try {
    fd = fs.openSync(destination, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || previous && (previous.ino !== actual.ino || previous.dev !== actual.dev)) fail('DATASET_PATH_DENIED', 'The destination file changed while being opened.');
    return fd;
  } catch (reason) { if (fd !== undefined) fs.closeSync(fd); if (reason instanceof DatasetError) throw reason; fail('DATASET_PATH_DENIED', 'The destination could not be safely opened.'); }
}
function fileUnchanged(fd, destination) {
  const opened = fs.fstatSync(fd); let actual;
  try { actual = fs.lstatSync(destination); } catch { fail('DATASET_PATH_DENIED', 'The partial download file disappeared.'); }
  if (!opened.isFile() || opened.nlink !== 1 || !actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1
    || opened.ino !== actual.ino || opened.dev !== actual.dev) fail('DATASET_PATH_DENIED', 'The partial download file changed or acquired a link.');
  return opened;
}
function contentLength(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail('DATASET_INVALID_RESPONSE', 'The dataset source returned an invalid content length.', 502);
  return Number(value);
}

/** Streams raw bytes only. The caller owns source authorization, partial
 * metadata and final expected-hash verification; this module never unpacks. */
export function createDatasetDownloader({ lookupImpl = lookup, requestImpl = requestPinned, proxyUrl = process.env.SCIENCEPRISM_DATASET_DOWNLOAD_PROXY,
  maxBytes = MAX_DATASET_BYTES, timeoutMs = 60000 } = {}) {
  if (typeof lookupImpl !== 'function' || typeof requestImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DATASET_BYTES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) fail('DATASET_DOWNLOAD_CONFIGURATION', 'The dataset downloader configuration is invalid.', 503);
  let proxy;
  try { proxy = parseDownloadProxy(proxyUrl); } catch { fail('DATASET_PROXY_CONFIGURATION', 'The trusted dataset download proxy configuration is invalid.', 503); }
  return async function downloadDataset(value, { destination, signal, onProgress = () => {}, beforeRequest = async () => {}, resume } = {}) {
    let url = parseDatasetUrl(value); const hfRedirect = url.hostname === 'huggingface.co';
    if (typeof onProgress !== 'function' || typeof beforeRequest !== 'function' || resume !== undefined && (!resume || typeof resume !== 'object' || Array.isArray(resume)
      || Object.keys(resume).some(key => !['receivedBytes', 'etag', 'resolvedUrl'].includes(key)))) fail('DATASET_RESUME_INVALID', 'Download progress and partial metadata are invalid.');
    const timeout = AbortSignal.timeout(timeoutMs), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let fd;
    try {
      requestSignal.throwIfAborted(); fd = destinationFile(destination);
      const existing = fileUnchanged(fd, destination).size;
      if (existing > maxBytes) fail('DATASET_TOO_LARGE', 'The partial dataset exceeds the download byte limit.', 413);
      let resumable = false, resumeUrl;
      if (resume && strongEtag(resume.etag) && Number.isSafeInteger(resume.receivedBytes) && resume.receivedBytes > 0) {
        if (resume.receivedBytes !== existing) fail('DATASET_RESUME_CONFLICT', 'The saved partial length does not match the actual file.', 409);
        resumeUrl = parseUrl(resume.resolvedUrl, { hfRedirect }).toString(); resumable = true;
      }
      for (let hop = 0; hop <= 4; hop++) {
        requestSignal.throwIfAborted(); let selected = null;
        if (!proxy) {
          const addresses = await abortable(lookupImpl(url.hostname, { all: true, verbatim: true }), requestSignal);
          if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || !isPublicAddress(item.address) || isIP(item.address) !== item.family)) fail('DATASET_PRIVATE_ADDRESS', 'The dataset source resolves to a private or reserved address.', 422);
          selected = addresses.find(item => item.family === 4) || addresses[0];
        }
        const offset = resumable && url.toString() === resumeUrl ? existing : 0;
        const headers = offset ? { Range: `bytes=${offset}-`, 'If-Range': resume.etag } : {};
        await beforeRequest({url:url.toString()}); requestSignal.throwIfAborted();
        const operation = Promise.resolve(requestImpl(url, selected, { signal: requestSignal, proxyUrl: proxy, headers })).then(response => {
          if (requestSignal.aborted) { response.destroy(); requestSignal.throwIfAborted(); } return response;
        });
        const response = await abortable(operation, requestSignal), status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy(); if (!response.headers.location) fail('DATASET_BAD_REDIRECT', 'The dataset redirect has no destination.', 502);
          let next; try { next = new URL(response.headers.location, url).toString(); } catch { fail('DATASET_BAD_REDIRECT', 'The dataset redirect is invalid.', 502); }
          url = parseUrl(next, { hfRedirect }); continue;
        }
        const abortResponse = () => response.destroy(requestSignal.reason); requestSignal.addEventListener('abort', abortResponse, { once: true });
        try {
          if ([401, 403].includes(status)) fail('DATASET_AUTH_REQUIRED', 'This dataset requires access authorization; no credentials are sent automatically.', 403);
          if (![200, 206].includes(status)) fail('DATASET_DOWNLOAD_HTTP_ERROR', `The dataset source returned HTTP ${Number(status) || 'unknown'}.`, 502);
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') fail('DATASET_INVALID_RESPONSE', 'The dataset source must return raw identity-encoded bytes.', 502);
          const length = contentLength(response.headers['content-length']); let start = 0, total = length, rangeLength;
          if (status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
            if (!offset || !range || range.slice(1).some(value => !Number.isSafeInteger(Number(value))) || Number(range[1]) !== offset
              || Number(range[2]) < offset || Number(range[2]) >= Number(range[3]) || response.headers.etag !== resume.etag) fail('DATASET_RESUME_CONFLICT', 'The partial response does not match its fixed validator and byte range.', 409);
            start = offset; total = Number(range[3]); rangeLength = Number(range[2]) - start + 1;
            if (length !== null && length !== rangeLength) fail('DATASET_RESUME_CONFLICT', 'The partial response length disagrees with its byte range.', 409);
          }
          if (total !== null && total > maxBytes || length !== null && start + length > maxBytes) fail('DATASET_TOO_LARGE', 'The dataset exceeds the download byte limit.', 413);
          fileUnchanged(fd, destination); const hash = createHash('sha256');
          if (start) {
            const prefix = Buffer.alloc(65536); let position = 0;
            while (position < start) {
              requestSignal.throwIfAborted(); const read = fs.readSync(fd, prefix, 0, Math.min(prefix.length, start - position), position);
              if (!read) fail('DATASET_RESUME_CONFLICT', 'The partial prefix changed before append.', 409);
              hash.update(prefix.subarray(0, read)); position += read;
            }
          } else fs.ftruncateSync(fd, 0);
          let received = start;
          const etag = strongEtag(response.headers.etag) ? response.headers.etag : null;
          const progress = async () => { await onProgress({ receivedBytes: received, totalBytes: total, etag, resolvedUrl: url.toString() }); requestSignal.throwIfAborted(); };
          await progress();
          for await (const part of response) {
            requestSignal.throwIfAborted(); const bytes = Buffer.from(part);
            if (received + bytes.length > maxBytes) fail('DATASET_TOO_LARGE', 'The dataset exceeds the download byte limit.', 413);
            if (length !== null && received - start + bytes.length > length || rangeLength !== undefined && received - start + bytes.length > rangeLength) fail('DATASET_INVALID_RESPONSE', 'The dataset response exceeds its declared length.', 502);
            fileUnchanged(fd, destination); let written = 0;
            while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, received + written);
            received += bytes.length; hash.update(bytes); await progress();
          }
          requestSignal.throwIfAborted(); fileUnchanged(fd, destination); fs.fsyncSync(fd);
          if (total !== null && received !== total || length !== null && received - start !== length) fail('DATASET_DOWNLOAD_INCOMPLETE', 'The dataset stream ended before its complete declared bytes arrived.', 502);
          return { sha256: hash.digest('hex'), byteLength: received, resolvedUrl: url.toString(), etag };
        } finally { requestSignal.removeEventListener('abort', abortResponse); response.destroy(); }
      }
      fail('DATASET_BAD_REDIRECT', 'The dataset source redirected too many times.', 502);
    } catch (reason) {
      if (signal?.aborted) fail('DATASET_CANCELLED', 'Dataset download cancelled; its partial file is preserved.', 499);
      if (requestSignal.aborted) fail('DATASET_TIMEOUT', 'Dataset download timed out; its partial file is preserved.', 504);
      if (reason instanceof DatasetError) throw reason;
      fail('DATASET_DOWNLOAD_FAILED', 'The dataset source or partial storage could not complete the download.', 502);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
}
