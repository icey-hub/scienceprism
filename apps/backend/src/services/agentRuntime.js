import { runToolAgent } from './agentService.js';
import { runDeepSeekHarness } from './deepseekHarnessService.js';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveAgentRuntime(llmConfig) {
  const value = llmConfig?.runtime || process.env.OPENPRISM_AGENT_RUNTIME || 'legacy';
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'deepseek-harness' || normalized === 'harness' ? 'deepseek-harness' : 'legacy';
}

export function getAgentRuntimeStatus(llmConfig) {
  const runtime = resolveAgentRuntime(llmConfig);
  const localSdk = path.join(os.homedir(), 'Desktop/DeepSeek Harness/deepseek-harness/packages/sdk/client/lib/index.js');
  const configuredSdk = process.env.OPENPRISM_HARNESS_SDK;
  return {
    runtime,
    harnessConfigured: Boolean((configuredSdk && existsSync(configuredSdk)) || existsSync(localSdk)),
    fallback: process.env.OPENPRISM_HARNESS_FALLBACK !== 'false'
  };
}

export async function runAgentRuntime(params) {
  if (resolveAgentRuntime(params.llmConfig) === 'deepseek-harness') {
    const harnessResult = await runDeepSeekHarness(params);
    const fallbackEnabled = process.env.OPENPRISM_HARNESS_FALLBACK !== 'false';
    if (harnessResult.ok || !fallbackEnabled) return harnessResult;

    try {
      const legacyResult = await runToolAgent(params);
      return {
        ...legacyResult,
        runtime: 'legacy',
        fallback: true,
        harnessError: harnessResult.reply
      };
    } catch (error) {
      return {
        ...harnessResult,
        fallback: true,
        fallbackError: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return runToolAgent(params);
}
