import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const SUPPORTED_PDF_HOSTS = Object.freeze(['arxiv.org', 'export.arxiv.org', 'pmc.ncbi.nlm.nih.gov', 'europepmc.org', 'zenodo.org']);

export class AttachmentError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Reject malformed and non-absolute URLs below. */ }
  if (typeof value !== 'string' || value.length > 4096 || !url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new AttachmentError('ATTACHMENT_INVALID_URL', 'Use a public HTTPS PDF URL without credentials or a fragment.');
  }
  if (!SUPPORTED_PDF_HOSTS.includes(url.hostname)) {
    throw new AttachmentError('ATTACHMENT_SOURCE_UNSUPPORTED', 'Automatic downloads currently support arXiv, PMC, Europe PMC and Zenodo. Download other authorized PDFs yourself and import the file.', 422);
  }
  return url;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast IPv6; exclude special-purpose, documentation and IPv4
  // tunnel ranges, including compressed representations such as 2001::1.
  const ip = address.toLowerCase();
  const [first, second = '0'] = ip.split(':');
  return family === 6 && /^[23][0-9a-f]{3}:/.test(ip) && !(first === '2001' && (parseInt(second || '0', 16) < 0x200 || parseInt(second, 16) === 0xdb8))
    && first !== '2002' && first !== '3fff';
}

export function parseDownloadProxy(value) {
  if (value === undefined || value === '') return null;
  let proxy;
  try {
    proxy = new URL(value);
    // Decode once here so invalid proxy credentials fail without leaking them.
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
  } catch { proxy = null; /* Never include the configured URL in errors. */ }
  if (typeof value !== 'string' || value.length > 4096 || !proxy || !['http:', 'https:'].includes(proxy.protocol)
      || !proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new AttachmentError('ATTACHMENT_PROXY_CONFIGURATION', 'The configured PDF download proxy must be an HTTP or HTTPS proxy URL.', 503);
  }
  return proxy;
}

function requestPinned(url, address, { signal, proxyUrl }) {
  return new Promise((resolve, reject) => {
    let agent;
    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      const headers = {};
      if (proxy.username || proxy.password) {
        headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
        proxy.username = ''; proxy.password = '';
      }
      // The signal also reaches the proxy TCP/TLS connection while CONNECT is
      // pending. TLS verification remains enabled for both proxy and PDF host.
      agent = new HttpsProxyAgent(proxy, { headers, signal, rejectUnauthorized: true });
    }
    const req = https.request(url, { method: 'GET', agent: agent || false, signal, rejectUnauthorized: true,
      headers: { Accept: 'application/pdf', 'User-Agent': 'SciencePrism/1.0 (open-access paper download)', 'Accept-Encoding': 'identity' },
      ...(!agent ? { lookup: (_host, options, done) => options.all ? done(null, [address]) : done(null, address.address, address.family) } : {})
    }, response => resolve(response));
    req.once('error', reject);
    req.once('close', () => agent?.destroy());
    req.end();
  });
}

async function abortable(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Direct mode pins validated public DNS. Explicit trusted proxy mode delegates
 * DNS to that proxy, retaining the same exact-host and redirect restrictions. */
export function createPdfDownloader({ lookupImpl = lookup, requestImpl = requestPinned, maxBytes = MAX_PDF_BYTES,
  timeoutMs = 60000, proxyUrl = process.env.SCIENCEPRISM_PAPER_DOWNLOAD_PROXY } = {}) {
  return async function downloadPdf(value, { signal, onProgress = () => {} } = {}) {
    let url = parseDownloadUrl(value);
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const redirects = [];
    try {
      const proxy = parseDownloadProxy(proxyUrl);
      for (let hop = 0; hop <= 4; hop++) {
        requestSignal.throwIfAborted();
        let selected = null;
        if (!proxy) {
          const addresses = await abortable(lookupImpl(url.hostname, { all: true, verbatim: true }), requestSignal);
          requestSignal.throwIfAborted();
          if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || ![4, 6].includes(item.family))) {
            throw new AttachmentError('ATTACHMENT_PRIVATE_ADDRESS', 'The PDF URL resolves to a private or reserved address.', 422);
          }
          selected = addresses.find(item => item.family === 4) || addresses[0];
        }
        const response = await abortable(requestImpl(url, selected, { signal: requestSignal, proxyUrl: proxy }), requestSignal);
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          const location = response.headers.location;
          if (!location) throw new AttachmentError('ATTACHMENT_BAD_REDIRECT', 'The PDF server returned a redirect without a destination.', 502);
          url = parseDownloadUrl(new URL(location, url).toString());
          redirects.push(url.toString());
          continue;
        }
        if (status !== 200) {
          response.destroy();
          throw new AttachmentError('ATTACHMENT_DOWNLOAD_HTTP_ERROR', `The PDF source returned HTTP ${status}.`, 502);
        }
        const total = Number(response.headers['content-length']);
        if (Number.isFinite(total) && total > maxBytes) {
          response.destroy();
          throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'The PDF exceeds the 32 MiB limit.', 413);
        }
        const parts = [];
        let received = 0;
        try {
          for await (const part of response) {
            requestSignal.throwIfAborted();
            const bytes = Buffer.from(part);
            received += bytes.length;
            if (received > maxBytes) throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'The PDF exceeds the 32 MiB limit.', 413);
            parts.push(bytes);
            await onProgress({ received, total: Number.isFinite(total) && total > 0 ? total : null });
          }
        } finally { response.destroy(); }
        requestSignal.throwIfAborted();
        return { bytes: Buffer.concat(parts), sourceUrl: value, resolvedUrl: url.toString(), redirects, transport: proxy ? 'trusted-proxy' : 'direct' };
      }
      throw new AttachmentError('ATTACHMENT_BAD_REDIRECT', 'The PDF source redirected too many times.', 502);
    } catch (error) {
      if (signal?.aborted) throw new AttachmentError('ATTACHMENT_CANCELLED', 'PDF download cancelled.', 499);
      if (requestSignal.aborted) throw new AttachmentError('ATTACHMENT_TIMEOUT', 'PDF download timed out.', 504);
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError('ATTACHMENT_DOWNLOAD_FAILED', 'The PDF source could not be reached. Retry later or import a local PDF.', 502);
    }
  };
}
