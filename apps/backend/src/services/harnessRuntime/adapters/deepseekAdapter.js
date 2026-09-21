import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from '../../llmService.js';
import { getEnv } from '../../../config/constants.js';
import { HarnessRuntimeError } from '../errors.js';
import { capabilityPrompt } from '../capabilities.js';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadHarnessSdk() {
  const candidates = [];
  if (getEnv('HARNESS_SDK')) candidates.push(getEnv('HARNESS_SDK'));
  candidates.push(path.join(homedir(), 'Desktop/DeepSeek Harness/deepseek-harness/packages/sdk/client/lib/index.js'));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return import(pathToFileURL(candidate).href);
  }

  try {
    return await import('@deepseek-ai/dsh-sdk-client');
  } catch {
    throw new HarnessRuntimeError(
      503,
      'PROVIDER_UNAVAILABLE',
      'DeepSeek Harness SDK not found. Set SCIENCEPRISM_HARNESS_SDK to packages/sdk/client/lib/index.js.',
      undefined,
      { retryable: true }
    );
  }
}

function eventSummary(event) {
  const source = event?.params?.event || event;
  return {
    type: source?.type || event?.method || 'unknown',
    name: source?.data?.name,
    callId: source?.data?.callId,
    tool: source?.data?.tool,
    text: source?.type === 'assistant/message'
      ? source.data?.message?.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('')
      : undefined
  };
}

function eventFailure(events = []) {
  const terminal = [...events].reverse().find((event) => event?.type === 'turn/end');
  if (terminal?.data?.reason?.kind !== 'error') return '';
  return terminal.data.reason.error?.message || terminal.data.reason.error?.code || 'agent turn failed';
}

function buildInput(request, policy) {
  return [
    `Task: ${request.task || 'polish'}`,
    request.activePath ? `Active file: ${request.activePath}` : '',
    request.prompt ? `User prompt: ${request.prompt}` : '',
    request.selection ? `Selection:\n${request.selection}` : '',
    request.compileLog ? `Compile log:\n${request.compileLog}` : '',
    request.contextPack ? `Structured context pack (authoritative snapshot):\n${JSON.stringify(request.contextPack)}` : '',
    capabilityPrompt(policy),
    'Work only inside the provided temporary workspace. Never treat a generated change as applied; return proposed changes for human confirmation.'
  ].filter(Boolean).join('\n\n');
}

export const deepseekHarnessAdapter = Object.freeze({
  id: 'deepseek',
  label: 'DeepSeek Harness SDK Adapter',
  async run({ request, workspace, dshHome, capabilities, signal, emit }) {
    const resolved = resolveLLMConfig(request.llmConfig);
    const timeoutMs = Number(request.limits?.timeoutMs || getEnv('HARNESS_TIMEOUT_MS') || 10 * 60 * 1000);
    const { DeepSeekHarness } = await loadHarnessSdk();
    const configuredEndpoint = typeof request.llmConfig?.endpoint === 'string' && request.llmConfig.endpoint.trim()
      ? request.llmConfig.endpoint.trim()
      : (getEnv('LLM_ENDPOINT') || '').trim();
    const defaultEndpoint = normalizeChatEndpoint(undefined);
    const configuredBaseUrl = normalizeBaseURL(normalizeChatEndpoint(resolved.endpoint));
    const inheritedBaseUrl = (process.env.DEEPSEEK_BASE_URL || '').trim();
    const baseUrl = !configuredEndpoint || configuredEndpoint === defaultEndpoint
      ? (inheritedBaseUrl || undefined)
      : configuredBaseUrl;
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: resolved.apiKey || process.env.DEEPSEEK_API_KEY || '',
      ...(baseUrl ? { DEEPSEEK_BASE_URL: baseUrl } : {})
    };
    if (!env.DEEPSEEK_API_KEY) {
      throw new HarnessRuntimeError(503, 'PROVIDER_UNAVAILABLE', 'DeepSeek API key is not configured.', undefined, { retryable: true });
    }

    const harness = new DeepSeekHarness({
      profile: getEnv('HARNESS_PROFILE') || 'sdk',
      ...(getEnv('HARNESS_DSH_BIN') ? { dshBin: getEnv('HARNESS_DSH_BIN') } : {}),
      cwd: workspace,
      processCwd: workspace,
      dshHome,
      provider: getEnv('HARNESS_PROVIDER') || 'deepseek-official',
      model: resolved.model || process.env.DEEPSEEK_MODEL || 'deepseek-flash',
      maxTokens: Number(request.limits?.maxTokens || getEnv('HARNESS_MAX_TOKENS') || 49152),
      env,
      requestTimeoutMs: timeoutMs,
      initializeTimeoutMs: Math.min(timeoutMs, 30_000)
    });
    const abort = () => { void harness.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    const sessionId = `scienceprism-${request.projectId}-${randomUUID()}`;
    try {
      emit({ type: 'adapter/started', data: { adapter: 'deepseek', model: resolved.model || 'deepseek-flash' } });
      const result = await harness.run(buildInput(request, { granted: capabilities }), {
        sessionId,
        onNotification: (notification) => emit(eventSummary(notification))
      });
      const failure = eventFailure(result.events);
      if (failure) {
        throw new HarnessRuntimeError(502, 'PROVIDER_ERROR', `DeepSeek Harness failed: ${failure}`, { sessionId }, { retryable: true });
      }
      return {
        ok: true,
        finalResponse: result.finalResponse || '',
        events: result.events.map(eventSummary),
        sessionId: result.sessionId,
        notifications: result.notifications?.map(eventSummary) || []
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      await harness.close().catch(() => {});
    }
  }
});
