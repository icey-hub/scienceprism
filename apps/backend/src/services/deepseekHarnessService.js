import { runHarnessRequest } from './harnessRuntime/index.js';

/**
 * Backward-compatible entry point for editor callers. The Harness Runtime now
 * owns lifecycle, isolation, events, Patches, fallback, and Run persistence.
 */
export function runDeepSeekHarness(params = {}) {
  return runHarnessRequest({ ...params, adapter: 'deepseek' });
}
