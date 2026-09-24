import { DEFAULT_PROJECT_CAPABILITIES } from '../services/harnessRuntime/capabilities.js';

/**
 * Single source of truth for a Project's constraint defaults.
 *
 * These numbers used to be restated in four places -- the Harness Runtime
 * limits, the project dashboard that also writes the constraint file, the
 * DeepSeek adapter's token fallback, and the capability resolver -- so the
 * effective default depended on which module you happened to ask, and changing
 * one silently left the others behind.
 *
 * The capability list itself stays owned by `harnessRuntime/capabilities.js`
 * because it is the capability vocabulary; this module only aggregates the
 * defaults that form a Project Constraint document.
 */
export const PROJECT_CONSTRAINT_LIMITS = Object.freeze({
  maxTokens: 49152,
  timeoutMs: 10 * 60 * 1000,
  maxConcurrent: 1,
  retryLimit: 1,
  contextTokenBudget: 12000
});

export const PROJECT_CONSTRAINT_DEFAULTS = Object.freeze({
  capabilities: DEFAULT_PROJECT_CAPABILITIES,
  allowedPaths: [],
  networkAllowlist: [],
  fallback: true,
  ...PROJECT_CONSTRAINT_LIMITS
});
