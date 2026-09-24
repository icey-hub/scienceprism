import path from 'node:path';
import { HarnessRuntimeError } from './errors.js';

// The vocabulary of capabilities a Project can grant. It lists only what the
// Runtime can actually assert: direct project writes are represented by
// `patch.propose` plus an explicit human application step, so a `project.write`
// capability was grantable but unenforceable and has been removed.
export const HARNESS_CAPABILITIES = Object.freeze([
  'project.read',
  'research.search',
  'patch.propose',
  'experiment.execute'
]);

export const DEFAULT_PROJECT_CAPABILITIES = Object.freeze([
  'project.read',
  'patch.propose'
]);

const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|.*\.(?:key|pem|p12|secret))$/i;
const SENSITIVE_DIRECTORIES = new Set([
  '.git',
  '.scienceprism',
  '.openprism',
  '.agent_runs',
  '.cache',
  'node_modules'
]);

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function normalizedRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (raw === '') return '';
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '' : normalized;
}

export function normalizeCapabilityList(value) {
  return uniqueStrings(value).filter((name) => HARNESS_CAPABILITIES.includes(name));
}

export function resolveCapabilityPolicy({ requested, configured } = {}) {
  const configuredCapabilities = normalizeCapabilityList(configured || DEFAULT_PROJECT_CAPABILITIES);
  const requestedCapabilities = requested === undefined
    ? configuredCapabilities
    : normalizeCapabilityList(requested);
  const granted = requestedCapabilities.filter((name) => configuredCapabilities.includes(name));
  return {
    requested: requestedCapabilities,
    configured: configuredCapabilities,
    granted,
    denied: requestedCapabilities.filter((name) => !granted.includes(name)),
    allowedPaths: [],
    networkAllowlist: []
  };
}

export function applyProjectConstraintPolicy(policy, constraints = {}) {
  const base = policy || resolveCapabilityPolicy();
  const allowedPaths = uniqueStrings(constraints.allowedPaths || constraints.fileScope);
  const networkAllowlist = uniqueStrings(constraints.networkAllowlist || constraints.networkHosts);
  return {
    ...base,
    allowedPaths,
    networkAllowlist,
    constraints: {
      maxTokens: Number.isFinite(Number(constraints.maxTokens)) ? Number(constraints.maxTokens) : undefined,
      timeoutMs: Number.isFinite(Number(constraints.timeoutMs)) ? Number(constraints.timeoutMs) : undefined,
      maxConcurrent: Number.isFinite(Number(constraints.maxConcurrent)) ? Number(constraints.maxConcurrent) : undefined,
      retryLimit: Number.isFinite(Number(constraints.retryLimit)) ? Number(constraints.retryLimit) : undefined,
      contextTokenBudget: Number.isFinite(Number(constraints.contextTokenBudget)) ? Number(constraints.contextTokenBudget) : undefined,
      fallback: constraints.fallback !== false
    }
  };
}

export function hasCapability(policy, capability) {
  return Boolean(policy?.granted?.includes(capability));
}

export function assertCapability(policy, capability) {
  if (hasCapability(policy, capability)) return;
  throw new HarnessRuntimeError(403, 'CAPABILITY_DENIED', `Harness capability denied: ${capability}.`, {
    capability,
    granted: policy?.granted || []
  });
}

export function isSensitivePath(relativePath) {
  const normalized = normalizedRelativePath(relativePath);
  if (normalized === null) return true;
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part) => SENSITIVE_DIRECTORIES.has(part) || SENSITIVE_FILE.test(part));
}

export function isPathAllowed(relativePath, policy, { operation = 'read' } = {}) {
  const normalized = normalizedRelativePath(relativePath);
  if (normalized === null || isSensitivePath(normalized)) return false;
  const allowedPaths = policy?.allowedPaths || [];
  if (!allowedPaths.length) return true;
  return allowedPaths.some((prefix) => {
    const normalizedPrefix = normalizedRelativePath(prefix);
    return normalizedPrefix !== null && (normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`));
  });
}

export function assertProjectPath(relativePath, policy, { operation = 'read' } = {}) {
  const capability = operation === 'patch' ? 'patch.propose' : 'project.read';
  assertCapability(policy, capability);
  if (!isPathAllowed(relativePath, policy, { operation })) {
    throw new HarnessRuntimeError(403, 'PATH_DENIED', `Harness path denied: ${relativePath || '(project root)'}.`, {
      path: relativePath,
      operation,
      allowedPaths: policy?.allowedPaths || []
    });
  }
  return normalizedRelativePath(relativePath);
}

function normalizedToolName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s.-]+/g, '_');
}

export function capabilityForToolName(name) {
  const tool = normalizedToolName(name);
  if (!tool) return null;
  if (/^(?:write|edit|delete|move|rename)_?file$/.test(tool) || tool.includes('filesystem_write')) return 'patch.propose';
  if (tool.includes('shell') || tool.includes('bash') || tool.includes('terminal') || tool.includes('execute_command')) return 'experiment.execute';
  if (tool.includes('arxiv') || tool.includes('search') || tool.includes('fetch_url') || tool.includes('http')) return 'research.search';
  if (tool === 'read_file' || tool === 'list_files' || tool.includes('filesystem_read')) return 'project.read';
  if (tool.includes('patch') || tool.includes('edit')) return 'patch.propose';
  return null;
}

export function assertNetworkHost(policy, url) {
  assertCapability(policy, 'research.search');
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new HarnessRuntimeError(403, 'NETWORK_DENIED', 'Harness network URL is invalid.', { url });
  }
  // Fail closed. An empty allowlist denies every host, which is what
  // capabilityPrompt has always told the model ("Allowed network hosts: none").
  // It previously allowed any host when the list was empty, so the sentence the
  // model was given and the enforcement disagreed. A project that wants network
  // access now names the hosts it wants.
  const allowlist = policy?.networkAllowlist || [];
  if (!allowlist.includes(host)) {
    throw new HarnessRuntimeError(403, 'NETWORK_DENIED', `Harness network host denied: ${host}.`, { host, allowlist });
  }
  return host;
}

export function capabilityPrompt(policy) {
  const granted = policy?.granted || [];
  const denied = HARNESS_CAPABILITIES.filter((name) => !granted.includes(name));
  const allowedPaths = policy?.allowedPaths || [];
  const networkAllowlist = policy?.networkAllowlist || [];
  return [
    `Granted Harness capabilities: ${granted.length ? granted.join(', ') : 'none'}.`,
    `Denied Harness capabilities: ${denied.length ? denied.join(', ') : 'none'}.`,
    `Allowed project paths: ${allowedPaths.length ? allowedPaths.join(', ') : 'all non-sensitive project paths subject to the Runtime filter'}.`,
    `Allowed network hosts: ${networkAllowlist.length ? networkAllowlist.join(', ') : 'none unless the Runtime policy grants and validates a host'}.`,
    'Never write the original project, execute Shell commands, access sensitive files, or use network tools unless the matching capability is explicitly granted.',
    'File changes must remain proposed Patches and require human confirmation.'
  ].join(' ');
}
