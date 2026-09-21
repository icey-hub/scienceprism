import { getEnv } from '../config/constants.js';

export function normalizeChatEndpoint(endpoint) {
  if (!endpoint) return 'https://api.openai.com/v1/chat/completions';
  let url = endpoint.trim();
  if (!url) return 'https://api.openai.com/v1/chat/completions';
  url = url.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  if (/\/v1\//i.test(url)) return url;
  return `${url}/v1/chat/completions`;
}

export function normalizeBaseURL(endpoint) {
  if (!endpoint) return undefined;
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.replace(/\/chat\/completions$/i, '');
}

export function resolveLLMConfig(llmConfig) {
  return {
    endpoint: (llmConfig?.endpoint || getEnv('LLM_ENDPOINT') || 'https://api.openai.com/v1/chat/completions').trim(),
    apiKey: (llmConfig?.apiKey || getEnv('LLM_API_KEY') || '').trim(),
    model: (llmConfig?.model || getEnv('LLM_MODEL') || 'gpt-4o-mini').trim()
  };
}

export async function callOpenAICompatible({ messages, model, endpoint, apiKey }) {
  const finalEndpoint = normalizeChatEndpoint(endpoint || getEnv('LLM_ENDPOINT'));
  const finalApiKey = (apiKey || getEnv('LLM_API_KEY') || '').trim();
  const finalModel = (model || getEnv('LLM_MODEL') || 'gpt-4o-mini').trim();

  if (!finalApiKey) {
    return { ok: false, error: 'SCIENCEPRISM_LLM_API_KEY not set' };
  }

  const res = await fetch(finalEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${finalApiKey}`
    },
    body: JSON.stringify({
      model: finalModel,
      messages,
      temperature: 0.2
    })
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text || `Request failed with ${res.status}` };
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return { ok: false, error: text || 'Non-JSON response from provider.' };
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Response JSON parse failed.' };
  }
  const content = data?.choices?.[0]?.message?.content || '';
  return { ok: true, content };
}
