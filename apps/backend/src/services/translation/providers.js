export class TranslationError extends Error {
  constructor(code, message, statusCode = 502, retryAfter = null) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

const languages = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar'];
export const PROVIDERS = Object.freeze([
  { id: 'bing-web', label: 'Microsoft / Bing', mode: 'web-free', version: 'bing-web-v1', requiresCredentials: false, maxCharacters: 1000 },
  { id: 'google-web', label: 'Google', mode: 'web-free', version: 'google-web-v1', requiresCredentials: false, maxCharacters: 1000 }
].map(provider => Object.freeze({ ...provider, sourceLanguages: ['auto', ...languages], targetLanguages: [...languages] })));

function retrySeconds(value, now) {
  const seconds = /^\d+$/.test(value || '') ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : 60;
}

async function readBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'Translation provider returned an empty response.');
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new TranslationError('TRANSLATION_RESPONSE_TOO_LARGE', 'Translation provider response is too large.');
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

async function checkResponse(response, now) {
  if (response.ok) return;
  await response.body?.cancel().catch(() => {});
  if (response.status === 429) throw new TranslationError('TRANSLATION_RATE_LIMITED', 'Translation provider rate limit reached. Retry later or choose another provider.', 429, retrySeconds(response.headers.get('retry-after'), now()));
  if ([401, 403].includes(response.status)) throw new TranslationError('TRANSLATION_ACCESS_DENIED', 'This free translation service is unavailable or requires verification. Choose another provider.', 502);
  throw new TranslationError('TRANSLATION_HTTP_ERROR', `Translation provider request failed (HTTP ${response.status}).`);
}

function parseJson(body) {
  try { return JSON.parse(body); }
  catch { throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'Translation provider returned invalid JSON.'); }
}

function translatedText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000) throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'Translation provider returned no valid translated text.');
  return value;
}

// Web endpoints are separate from credentialed Azure/Google Cloud APIs. They have
// no published availability/quota guarantee; do not retry challenges or change IPs.
export function createWebTranslationProviders({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  let bingSession = null;
  const headers = { 'User-Agent': 'SciencePrism/1.0 (selected text translation)' };
  async function bingAuth(signal) {
    if (bingSession && now() < bingSession.expiresAt) return bingSession;
    let url = new URL('https://www.bing.com/translator');
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await fetchImpl(url.toString(), { headers, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        let next;
        try { next = new URL(location, url); } catch { /* Reject missing or malformed destinations. */ }
        if (!location || !next || next.protocol !== 'https:' || !['bing.com', 'www.bing.com', 'cn.bing.com'].includes(next.hostname) || next.port || next.username || next.password) {
          throw new TranslationError('TRANSLATION_UNSAFE_REDIRECT', 'Translation service redirected to an unsupported location.');
        }
        url = next;
        continue;
      }
      await checkResponse(response, now);
      const html = await readBody(response, 2 * 1024 * 1024);
      // Read values, never evaluate provider HTML or persist its temporary token.
      const auth = html.match(/params_AbusePreventionHelper\s*=\s*(\[[^\]]+\])/);
      const ig = html.match(/IG\s*:\s*"([A-Fa-f0-9]{1,64})"/);
      const iid = html.match(/data-iid\s*=\s*"([A-Za-z0-9_.-]{1,128})"/);
      const tuple = auth ? parseJson(auth[1]) : null;
      if (!ig || !iid || !Array.isArray(tuple) || !Number.isSafeInteger(tuple[0]) || tuple[0] <= 0 || typeof tuple[1] !== 'string' || !tuple[1] || tuple[1].length > 4096 || !Number.isFinite(tuple[2]) || tuple[2] <= 0) {
        throw new TranslationError('TRANSLATION_SESSION_UNAVAILABLE', 'Bing free translation session is unavailable. Try later or choose another provider.');
      }
      bingSession = { origin: url.origin, ig: ig[1], iid: iid[1], key: tuple[0], token: tuple[1], expiresAt: now() + Math.min(tuple[2], 3600000) - 1000 };
      return bingSession;
    }
    throw new TranslationError('TRANSLATION_UNSAFE_REDIRECT', 'Translation service redirected too many times.');
  }

  return {
    async 'bing-web'({ text, sourceLanguage, targetLanguage }, { signal }) {
      const session = await bingAuth(signal);
      signal.throwIfAborted();
      const codes = { auto: 'auto-detect', 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
      const endpoint = new URL('/ttranslatev3', session.origin);
      endpoint.search = new URLSearchParams({ isVertical: '1', IG: session.ig, IID: session.iid }).toString();
      const body = new URLSearchParams({ fromLang: codes[sourceLanguage] || sourceLanguage, to: codes[targetLanguage] || targetLanguage, text, key: String(session.key), token: session.token });
      const response = await fetchImpl(endpoint.toString(), { method: 'POST', redirect: 'error', signal,
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${session.origin}/translator` }, body: body.toString() });
      if ([401, 403].includes(response.status)) bingSession = null;
      await checkResponse(response, now);
      const value = parseJson(await readBody(response, 128 * 1024));
      if (value?.ShowCaptcha || value?.showCaptcha || value?.statusCode || value?.StatusCode) {
        bingSession = null;
        const status = Number(value.statusCode || value.StatusCode);
        if (status === 429) throw new TranslationError('TRANSLATION_RATE_LIMITED', 'Bing free translation rate limit reached. Retry later.', 429, 60);
        throw new TranslationError('TRANSLATION_SESSION_UNAVAILABLE', 'Bing free translation session needs verification or has expired. Choose another provider or retry later.');
      }
      const result = value?.[0];
      const language = result?.detectedLanguage?.language;
      return { translatedText: translatedText(result?.translations?.[0]?.text), detectedLanguage: typeof language === 'string' && language.length < 32 ? language : null };
    },
    async 'google-web'({ text, sourceLanguage, targetLanguage }, { signal }) {
      const endpoint = new URL('https://translate.googleapis.com/translate_a/single');
      endpoint.search = new URLSearchParams({ client: 'gtx', dt: 't', sl: sourceLanguage, tl: targetLanguage, q: text }).toString();
      const response = await fetchImpl(endpoint.toString(), { headers, redirect: 'error', signal });
      await checkResponse(response, now);
      const value = parseJson(await readBody(response, 128 * 1024));
      if (!Array.isArray(value?.[0]) || value[0].some(part => !Array.isArray(part) || typeof part[0] !== 'string')) {
        throw new TranslationError('TRANSLATION_INVALID_RESPONSE', 'Google free translation returned an invalid result.');
      }
      return { translatedText: translatedText(value[0].map(part => part[0]).join('')), detectedLanguage: typeof value[2] === 'string' && value[2].length < 32 ? value[2] : null };
    }
  };
}
