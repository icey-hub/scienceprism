import { PROVIDERS, TranslationError } from './providers.js';

const languages = Object.freeze([...PROVIDERS[0].targetLanguages]);
const MAX_RESPONSE_BYTES = 131_072;
const localErrors = new WeakSet();
const error = (code, message, status = 502, retryAfter = null) => {
  const value = new TranslationError(`TRANSLATION_${code}`, message, status, retryAfter);
  localErrors.add(value); return value;
};
export const OFFICIAL_TRANSLATION_PROVIDERS = Object.freeze([
  { id: 'azure-api', label: 'Microsoft Azure Translator', version: 'azure-translator-v3', documentationUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication' },
  { id: 'google-cloud', label: 'Google Cloud Translation / Basic NMT', version: 'google-cloud-basic-v2-nmt', documentationUrl: 'https://docs.cloud.google.com/translate/docs/authentication' }
].map(provider => Object.freeze({ ...provider, mode: 'official-api', requiresCredentials: true, maxCharacters: 1000,
  sourceLanguages: Object.freeze(['auto', ...languages]), targetLanguages: languages,
  capabilities: Object.freeze({ translation: true, explanation: false, nativeGlossary: false }),
  mayRequireBilling: true, freeAllowanceGuaranteed: false, billingBoundary: 'Official account calls may be billed. An application budget does not guarantee a remaining free allowance.'
})));
export const ALL_TRANSLATION_PROVIDERS = Object.freeze([...PROVIDERS, ...OFFICIAL_TRANSLATION_PROVIDERS]);

function settings(configuration, id) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(configuration) || Object.keys(configuration).some(key => !OFFICIAL_TRANSLATION_PROVIDERS.some(provider => provider.id === key))) return { status: 'invalid', enabled: false };
  const value = configuration[id];
  if (value === undefined) return { status: 'not-configured', enabled: false };
  const allowed = id === 'azure-api' ? ['enabled', 'apiKey', 'region'] : ['enabled', 'apiKey'];
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))
    || value.enabled !== undefined && typeof value.enabled !== 'boolean'
    || value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[^\x21-\x7e]/.test(value.apiKey))
    || value.region !== undefined && (typeof value.region !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.region))) return { status: 'invalid', enabled: value?.enabled === true };
  if (value.enabled === false) return { status: 'disabled', enabled: false };
  if (value.enabled !== true || !value.apiKey) return { status: 'not-configured', enabled: value.enabled === true };
  return { status: 'configured', enabled: true, apiKey: value.apiKey, ...(value.region ? { region: value.region } : {}) };
}

/** Public configuration only. A key's presence is neither enablement nor health. */
export function describeOfficialTranslationConfiguration(configuration = {}) {
  return Object.fromEntries(OFFICIAL_TRANSLATION_PROVIDERS.map(provider => {
    const value = settings(configuration, provider.id);
    return [provider.id, { configured: value.status === 'configured', configuration: { status: value.status, enabled: value.enabled } }];
  }));
}

function cancelled(signal) {
  return signal?.reason?.name === 'TimeoutError' ? error('TIMEOUT', 'Official translation timed out.', 504) : error('CANCELLED', 'Official translation was cancelled.', 499);
}
const checkAbort = signal => { if (signal?.aborted) throw cancelled(signal); };
function cancelBody(response) { try { void response?.body?.cancel().catch(() => {}); } catch { /* Cleanup must not expose a transport error. */ } }
async function abortable(pending, signal) {
  void pending.catch(() => {}); // An abort before admission must still consume a late rejection.
  checkAbort(signal);
  if (!signal) return pending;
  let rejectAbort;
  const listener = () => rejectAbort(cancelled(signal));
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  signal.addEventListener('abort', listener, { once: true });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

async function readBody(response, signal) {
  const declared = response.headers.get('content-length');
  if (/^\d+$/.test(declared || '') && Number(declared) > MAX_RESPONSE_BYTES) { cancelBody(response); throw error('RESPONSE_TOO_LARGE', 'Official translation response exceeds its byte limit.'); }
  const reader = response.body?.getReader();
  if (!reader) throw error('INVALID_RESPONSE', 'Official translation returned an empty response.');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await abortable(reader.read(), signal);
      checkAbort(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw error('RESPONSE_TOO_LARGE', 'Official translation response exceeds its byte limit.');
      chunks.push(value);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw error('INVALID_RESPONSE', 'Official translation returned invalid text encoding.'); }
  } finally { void reader.cancel().catch(() => {}); }
}

function retrySeconds(value, now) {
  const seconds = /^\d+$/.test(value || '') ? Number(value) : Math.ceil((Date.parse(value) - now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : 60;
}
function providerFailure(id, status, value, retryAfter) {
  if (status === 401) return error('AUTH_INVALID', 'Official translation authentication failed.', 401);
  if (status === 429) return error('RATE_LIMITED', 'Official translation is rate limited.', 429, retryAfter);
  if (status === 403) {
    if (id === 'azure-api' && Number(value?.error?.code) === 403001) return error('QUOTA_EXHAUSTED', 'The official translation account quota is exhausted.', 403);
    if (id === 'google-cloud') {
      const reasons = Array.isArray(value?.error?.errors) ? value.error.errors.slice(0, 16).map(item => item?.reason) : [];
      const message = typeof value?.error?.message === 'string' ? value.error.message : '';
      if (reasons.some(reason => ['userRateLimitExceeded', 'rateLimitExceeded'].includes(reason)) || /User Rate Limit Exceeded/i.test(message)) return error('RATE_LIMITED', 'Official translation is rate limited.', 429, retryAfter);
      if (reasons.some(reason => ['dailyLimitExceeded', 'quotaExceeded'].includes(reason)) || /Daily Limit Exceeded/i.test(message) || value?.error?.status === 'RESOURCE_EXHAUSTED') return error('QUOTA_EXHAUSTED', 'The official translation account quota is exhausted.', 403);
      if (reasons.includes('keyInvalid') || value?.error?.status === 'UNAUTHENTICATED') return error('AUTH_INVALID', 'Official translation authentication failed.', 401);
      if (reasons.includes('accessNotConfigured')) return error('CONFIGURATION_INVALID', 'The official translation account has not enabled this API.', 503);
    }
    return error('ACCESS_DENIED', 'The official translation account lacks access.', 403);
  }
  if (status === 400) return error('INVALID_INPUT', 'The official translation provider rejected the request.', 400);
  return error('UPSTREAM_UNAVAILABLE', 'The official translation service is unavailable.');
}

function decodeText(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return value.replace(/&(#x[0-9a-f]{1,8}|#[0-9]{1,10}|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw error('INVALID_RESPONSE', 'Official translation returned an invalid text entity.');
    return String.fromCodePoint(code);
  });
}
function resultText(value, key) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000 || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || value.includes(key)) throw error('INVALID_RESPONSE', 'Official translation returned no valid translated text.');
  return value;
}
function detectedLanguage(value, key) {
  if (typeof value !== 'string' || value.length > 32 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value) || value.includes(key)) return null;
  return { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }[value] || value;
}

/** Credentials are explicit in-memory input only; the existing service owns
 * operation identities, budgets, throttling, health and caching. No retries,
 * provider fallback, credential discovery or ledger is implemented here.
 */
export function createOfficialTranslationProviders({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, configuration = {} } = {}) {
  const configured = new Map(OFFICIAL_TRANSLATION_PROVIDERS.map(provider => [provider.id, settings(configuration, provider.id)]));
  return Object.freeze(Object.fromEntries(OFFICIAL_TRANSLATION_PROVIDERS.map(provider => [provider.id, async ({ text, sourceLanguage = 'auto', targetLanguage } = {}, { signal } = {}) => {
    try {
      if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw error('INVALID_INPUT', 'A valid translation cancellation signal is required.', 400);
      checkAbort(signal);
      const config = configured.get(provider.id);
      if (config.status === 'invalid') throw error('CONFIGURATION_INVALID', 'Official translation configuration is invalid.', 503);
      if (config.status !== 'configured') throw error('NOT_CONFIGURED', 'Explicitly configure and enable this official translation source before use.', 503);
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || Array.from(text).length > provider.maxCharacters
        || !provider.sourceLanguages.includes(sourceLanguage) || !provider.targetLanguages.includes(targetLanguage)) throw error('INVALID_INPUT', 'Select valid text and supported translation languages.', 400);
      const headers = { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json' };
      let endpoint, body;
      const azureCode = language => ({ 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[language] || language);
      if (provider.id === 'azure-api') {
        endpoint = new URL('https://api.cognitive.microsofttranslator.com/translate');
        endpoint.searchParams.set('api-version', '3.0'); endpoint.searchParams.set('to', azureCode(targetLanguage)); endpoint.searchParams.set('textType', 'plain');
        if (sourceLanguage !== 'auto') endpoint.searchParams.set('from', azureCode(sourceLanguage));
        headers['Ocp-Apim-Subscription-Key'] = config.apiKey;
        if (config.region) headers['Ocp-Apim-Subscription-Region'] = config.region;
        body = [{ Text: text }];
      } else {
        endpoint = new URL('https://translation.googleapis.com/language/translate/v2');
        headers['X-Goog-Api-Key'] = config.apiKey;
        body = { q: [text], target: targetLanguage, format: 'text', model: 'nmt', ...(sourceLanguage === 'auto' ? {} : { source: sourceLanguage }) };
      }
      const pending = Promise.resolve().then(() => { checkAbort(signal); return fetchImpl(endpoint.toString(), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal }); });
      // Also dispose a late response from a custom transport that ignores abort.
      void pending.then(response => { if (signal?.aborted) cancelBody(response); }, () => {});
      const response = await abortable(pending, signal);
      checkAbort(signal);
      if (response.status >= 300 && response.status < 400) { cancelBody(response); throw error('UNSAFE_REDIRECT', 'Official translation redirects are not followed.'); }
      const retryAfter = retrySeconds(response.headers.get('retry-after'), now);
      if ([401, 429].includes(response.status)) { cancelBody(response); throw providerFailure(provider.id, response.status, null, retryAfter); }
      const raw = await readBody(response, signal);
      let value;
      try { value = JSON.parse(raw); } catch { if (response.ok) throw error('INVALID_RESPONSE', 'Official translation returned invalid JSON.'); }
      if (!response.ok) throw providerFailure(provider.id, response.status, value, retryAfter);
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw error('INVALID_RESPONSE', 'Official translation returned an unsupported response type.');
      let translatedText, detected, metered = null;
      if (provider.id === 'azure-api') {
        if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0]?.translations) || value[0].translations.length !== 1 || value[0].translations[0]?.to !== azureCode(targetLanguage)) throw error('INVALID_RESPONSE', 'Azure translation returned an unexpected result shape.');
        translatedText = resultText(value[0].translations[0].text, config.apiKey); detected = value[0].detectedLanguage?.language;
        const usage = response.headers.get('x-metered-usage');
        if (/^\d+$/.test(usage || '') && Number.isSafeInteger(Number(usage))) metered = Number(usage);
      } else {
        const values = value?.data?.translations;
        if (!Array.isArray(values) || values.length !== 1 || values[0]?.model !== undefined && values[0].model !== 'nmt') throw error('INVALID_RESPONSE', 'Google translation returned an unexpected result shape.');
        translatedText = resultText(decodeText(resultText(values[0].translatedText, config.apiKey)), config.apiKey); detected = values[0].detectedSourceLanguage;
      }
      checkAbort(signal);
      return { translatedText, detectedLanguage: detectedLanguage(detected, config.apiKey), providerMeteredCharacters: metered };
    } catch (cause) {
      if (signal?.aborted) throw cancelled(signal);
      if (localErrors.has(cause)) throw cause;
      throw error('UPSTREAM_UNAVAILABLE', 'The official translation service is unavailable.');
    }
  }])));
}
