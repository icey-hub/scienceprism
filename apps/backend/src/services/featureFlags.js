import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from './projectService.js';

export const FEATURE_FLAGS = Object.freeze(['experimentExecution', 'advancedHarness']);

// Existing controlled execution and Harness adapters stay available by default;
// deployments can progressively disable or enable them through env/project policy.
export const DEFAULT_FEATURE_FLAGS = Object.freeze({
  experimentExecution: true,
  advancedHarness: true
});

export class FeatureFlagError extends Error {
  constructor(flag, details = {}) {
    super(`Feature flag is disabled: ${flag}.`);
    this.name = 'FeatureFlagError';
    this.code = 'FEATURE_FLAG_DISABLED';
    this.statusCode = 403;
    this.flag = flag;
    this.details = { flag, ...details };
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function envSuffix(flag) {
  return flag.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

export function getFeatureFlags({ constraints = {}, env = process.env } = {}) {
  const configured = constraints?.featureFlags && typeof constraints.featureFlags === 'object'
    ? constraints.featureFlags
    : {};
  const flags = {};
  for (const flag of FEATURE_FLAGS) {
    const suffix = envSuffix(flag);
    const envValue = env?.[`SCIENCEPRISM_FEATURE_${suffix}`] ?? env?.[`OPENPRISM_FEATURE_${suffix}`];
    const legacyValue = flag === 'experimentExecution' ? env?.SCIENCEPRISM_ENABLE_EXPERIMENT_EXECUTION : env?.SCIENCEPRISM_ENABLE_ADVANCED_HARNESS;
    const globalEnabled = parseBoolean(envValue ?? legacyValue, DEFAULT_FEATURE_FLAGS[flag]);
    flags[flag] = globalEnabled && parseBoolean(configured[flag], true);
  }
  return Object.freeze(flags);
}

export function isFeatureEnabled(flag, options = {}) {
  if (!FEATURE_FLAGS.includes(flag)) return false;
  return getFeatureFlags(options)[flag] === true;
}

export function assertFeatureEnabled(flag, options = {}) {
  if (isFeatureEnabled(flag, options)) return true;
  throw new FeatureFlagError(flag, options.details);
}

export async function getProjectFeatureFlags(projectId) {
  const root = await getProjectRoot(projectId);
  let constraints = {};
  try {
    const raw = await fs.readFile(path.join(root, '.scienceprism', 'project-constraints.json'), 'utf8');
    const value = JSON.parse(raw);
    constraints = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return getFeatureFlags({ constraints });
}

export async function assertProjectFeatureEnabled(projectId, flag, details) {
  const flags = await getProjectFeatureFlags(projectId);
  return assertFeatureEnabled(flag, { constraints: { featureFlags: flags }, details });
}
