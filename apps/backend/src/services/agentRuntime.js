import { listHarnessAdapters, runHarnessRequest } from './harnessRuntime/index.js';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEnv } from '../config/constants.js';

export function resolveAgentRuntime(llmConfig) {
  const value = llmConfig?.runtime || getEnv('AGENT_RUNTIME') || 'legacy';
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'deepseek-harness' || normalized === 'harness' ? 'deepseek-harness' : 'legacy';
}

export function getAgentRuntimeStatus(llmConfig) {
  const runtime = resolveAgentRuntime(llmConfig);
  const localSdk = path.join(os.homedir(), 'Desktop/DeepSeek Harness/deepseek-harness/packages/sdk/client/lib/index.js');
  const configuredSdk = getEnv('HARNESS_SDK');
  return {
    runtime,
    harnessConfigured: Boolean((configuredSdk && existsSync(configuredSdk)) || existsSync(localSdk)),
    fallback: getEnv('HARNESS_FALLBACK') !== 'false',
    adapters: listHarnessAdapters()
  };
}

export async function runAgentRuntime(params) {
  const runtime = resolveAgentRuntime(params.llmConfig);
  return runHarnessRequest({
    ...params,
    adapter: runtime === 'deepseek-harness' ? 'deepseek' : 'legacy',
    capabilities: params.capabilities || ['project.read', 'patch.propose'],
    fallback: runtime === 'deepseek-harness' ? getEnv('HARNESS_FALLBACK') !== 'false' : false
  });
}
