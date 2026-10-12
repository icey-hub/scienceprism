import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from '../../llmService.js';
import { getEnv } from '../../../config/constants.js';
import { HarnessRuntimeError } from '../errors.js';
import { capabilityPrompt } from '../capabilities.js';
import { formatHarnessInput } from '../contextPackager.js';
import { summarizeEvent, sumEventUsage } from '../runtimeEvents.js';
import { createDshProfile, loadVerifiedDshSdk, DSH_VERSION, DSH_PROVIDER } from '../dshProfile.js';

function eventFailure(events = []) {
  const terminal = [...events].reverse().find((event) => event?.type === 'turn/end');
  if (terminal?.data?.reason?.kind !== 'error') return '';
  return terminal.data.reason.error?.message || terminal.data.reason.error?.code || 'agent turn failed';
}

function buildInput(request, policy) {
  return [
    formatHarnessInput(request),
    capabilityPrompt(policy),
    'Work only inside the provided temporary workspace. Never treat a generated change as applied; return proposed changes for human confirmation.'
  ].filter(Boolean).join('\n\n');
}

function childEnvironment({ apiKey, dshHome }) {
  const env = {
    HOME: dshHome,
    TMPDIR: path.join(dshHome, 'tmp'),
    XDG_CONFIG_HOME: path.join(dshHome, 'config'),
    XDG_CACHE_HOME: path.join(dshHome, 'cache'),
    XDG_DATA_HOME: path.join(dshHome, 'data'),
    SCIENCEPRISM_DSH_KEY: apiKey,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1'
  };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export const deepseekHarnessAdapter = Object.freeze({
  id: 'deepseek',
  label: 'DeepSeek Harness SDK Adapter',
  async run({ request, workspace, dshHome, capabilities, capabilityPolicy, limits, signal, emit, readPolicy, onDecision, delegateCodex, skillProjection }) {
    if (!limits || !['maxTokens', 'timeoutMs'].every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)) {
      throw new HarnessRuntimeError(422, 'DSH_LIMITS_INVALID', 'The executor must supply positive finite token and timeout limits.');
    }
    const { maxTokens, timeoutMs } = limits;
    const resolved = resolveLLMConfig(request.llmConfig);
    if (getEnv('HARNESS_DSH_BIN') || getEnv('HARNESS_PROFILE') && getEnv('HARNESS_PROFILE') !== 'sdk-minimal') {
      throw new HarnessRuntimeError(503, 'DSH_PROFILE_UNVERIFIED', 'This Run requires the verified sdk-minimal profile and matching SDK runtime.');
    }
    const { DeepSeekHarness } = await loadVerifiedDshSdk(getEnv('HARNESS_SDK'));
    if (getEnv('HARNESS_PROVIDER') && getEnv('HARNESS_PROVIDER') !== DSH_PROVIDER) throw new HarnessRuntimeError(503, 'DSH_PROVIDER_UNVERIFIED', 'This profile uses the explicitly configured compatible provider route.');
    const baseUrl = normalizeBaseURL(normalizeChatEndpoint(resolved.endpoint));
    const env = childEnvironment({ apiKey: resolved.apiKey || '', dshHome });
    if (!env.SCIENCEPRISM_DSH_KEY) {
      throw new HarnessRuntimeError(503, 'PROVIDER_UNAVAILABLE', 'DeepSeek API key is not configured.', undefined, { retryable: true });
    }
    await Promise.all([
      fs.mkdir(env.TMPDIR, { recursive: true }),
      fs.mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
      fs.mkdir(env.XDG_CACHE_HOME, { recursive: true }),
      fs.mkdir(env.XDG_DATA_HOME, { recursive: true })
    ]);

    const profile = await createDshProfile({ workspace, dshHome, provider: { baseUrl, model: resolved.model }, readPolicy, onDecision, delegateCodex, skillProjection, emit, signal, timeoutMs });
    let harness;
    const abort = () => { void harness?.close().catch(() => {}); };
    const sessionId = `scienceprism-${request.projectId}-${randomUUID()}`;
    try {
      harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [profile.patchPath],
      cwd: workspace,
      processCwd: workspace,
      dshHome,
      provider: DSH_PROVIDER,
      model: resolved.model,
      maxTokens,
      env,
      requestTimeoutMs: timeoutMs,
      initializeTimeoutMs: Math.min(timeoutMs, 30_000)
      });
      signal?.addEventListener('abort', abort, { once: true });
      await harness.start();
      await profile.waitReady();
      if (signal?.aborted) throw new HarnessRuntimeError(409, 'RUN_CANCELLED', 'The DSH Run was cancelled before the model turn.');
      emit({ type: 'adapter/started', data: { adapter: 'deepseek', sdkVersion: DSH_VERSION, profile: 'sdk-minimal', model: resolved.model || 'deepseek-flash' } });
      const result = await harness.run(buildInput(request, capabilityPolicy || { granted: capabilities }), {
        sessionId,
        onNotification: (notification) => emit(notification)
      });
      const failure = eventFailure(result.events);
      if (failure) {
        throw new HarnessRuntimeError(502, 'PROVIDER_ERROR', `DeepSeek Harness failed: ${failure}`, { sessionId }, { retryable: true });
      }
      return {
        ok: true,
        usage: sumEventUsage(result.events),
        finalResponse: result.finalResponse || '',
        events: result.events.map(summarizeEvent),
        sessionId: result.sessionId,
        notifications: result.notifications?.map(summarizeEvent) || []
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      const stopped = await Promise.allSettled([harness?.close(), profile.close()]);
      if (stopped.some(result => result.status === 'rejected')) throw new HarnessRuntimeError(503, 'DSH_STOP_FAILED', 'The DSH runtime could not confirm a complete stop.');
    }
  }
});

export { buildInput, childEnvironment };
