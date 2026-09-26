const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const ALLOWED_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high']);

function setting(env, name) {
  return String(env[`SCIENCEPRISM_${name}`] ?? env[`OPENPRISM_${name}`] ?? '').trim();
}

export function resolveImageEndpoint(endpoint) {
  const base = String(endpoint || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Image endpoint must use HTTP or HTTPS.');
  if (/\/images\/generations$/i.test(base)) return base;
  const withoutChat = base.replace(/\/chat\/completions$/i, '');
  return `${/\/v1$/i.test(withoutChat) ? withoutChat : `${withoutChat}/v1`}/images/generations`;
}

function sameImageEndpoint(left, right) {
  if (!left || !right) return false;
  try {
    return resolveImageEndpoint(left).toLowerCase() === resolveImageEndpoint(right).toLowerCase();
  } catch {
    return false;
  }
}

export function resolveImageConfig(llmConfig, env = process.env) {
  const imageEndpoint = setting(env, 'IMAGE_ENDPOINT');
  const imageKey = setting(env, 'IMAGE_API_KEY');
  const llmEndpoint = setting(env, 'LLM_ENDPOINT');
  const llmKey = setting(env, 'LLM_API_KEY');
  const browserEndpoint = String(llmConfig?.endpoint || '').trim();
  const browserKey = String(llmConfig?.apiKey || '').trim();

  if (imageEndpoint) {
    const apiKey = imageKey
      || (sameImageEndpoint(imageEndpoint, browserEndpoint) ? browserKey : '')
      || (sameImageEndpoint(imageEndpoint, llmEndpoint) ? llmKey : '');
    return { endpoint: resolveImageEndpoint(imageEndpoint), apiKey };
  }

  if (browserEndpoint) {
    const apiKey = browserKey || (sameImageEndpoint(browserEndpoint, llmEndpoint) ? llmKey : '');
    return { endpoint: resolveImageEndpoint(browserEndpoint), apiKey };
  }

  if (llmEndpoint) return { endpoint: resolveImageEndpoint(llmEndpoint), apiKey: llmKey };

  return {
    endpoint: resolveImageEndpoint(),
    apiKey: String(env.OPENAI_API_KEY || '').trim()
  };
}

export async function generateGptImage({ prompt, size = '1536x1024', quality = 'medium', config = resolveImageConfig(), fetchImpl = fetch }) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt || cleanPrompt.length > 32000) throw new Error('Prompt must contain 1–32000 characters.');
  if (!ALLOWED_SIZES.has(size)) throw new Error('Unsupported image size.');
  if (!ALLOWED_QUALITIES.has(quality)) throw new Error('Unsupported image quality.');
  if (!config.apiKey) throw new Error('SCIENCEPRISM_IMAGE_API_KEY is not set.');

  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: cleanPrompt, size, quality, output_format: 'png', n: 1 }),
      signal: AbortSignal.timeout(180000)
    });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'Image generation timed out.' : 'Image provider could not be reached.');
  }
  if (!response.ok) throw new Error(`Image provider returned HTTP ${response.status}.`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Image provider returned invalid JSON.');
  }
  const base64 = payload?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 42_000_000) {
    throw new Error('Image provider returned no valid PNG image.');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Image provider returned an invalid PNG image.');
  return buffer;
}
