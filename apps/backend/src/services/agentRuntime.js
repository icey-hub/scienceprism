import { getRole } from './agentRoles/index.js';
import { listHarnessAdapters, runHarnessRequest } from './harnessRuntime/index.js';
import { getEnv } from '../config/constants.js';
import { loadVerifiedDshSdk, DSH_VERSION } from './harnessRuntime/dshProfile.js';

export function resolveAgentRuntime(llmConfig) {
  const value = llmConfig?.runtime || getEnv('AGENT_RUNTIME') || 'legacy';
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'deepseek-harness' || normalized === 'harness' ? 'deepseek-harness' : 'legacy';
}

export async function getAgentRuntimeStatus(llmConfig) {
  const runtime = resolveAgentRuntime(llmConfig);
  let harnessConfigured = false;
  try { await loadVerifiedDshSdk(getEnv('HARNESS_SDK')); harnessConfigured = true; } catch { /* Configuration remains unavailable until the execution profile verifies. */ }
  return {
    runtime,
    harnessConfigured,
    sdkVersion: DSH_VERSION,
    fallback: getEnv('HARNESS_FALLBACK') !== 'false',
    adapters: listHarnessAdapters()
  };
}

export async function runAgentRuntime(params) {
  const runtime = resolveAgentRuntime(params.llmConfig);
  const role = params.role ? getRole(params.role) : null;
  const defaultCapabilities = ['project.read', 'patch.propose'].filter(capability => !role || role.allowedCapabilities.includes(capability));
  return runHarnessRequest({
    ...params,
    adapter: runtime === 'deepseek-harness' ? 'deepseek' : 'legacy',
    capabilities: params.capabilities || defaultCapabilities,
    fallback: runtime === 'deepseek-harness' ? getEnv('HARNESS_FALLBACK') !== 'false' : false
  });
}
