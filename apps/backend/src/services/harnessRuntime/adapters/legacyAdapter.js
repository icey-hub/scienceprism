import { runToolAgent } from '../../agentService.js';
import { HarnessRuntimeError } from '../errors.js';

export const legacyHarnessAdapter = Object.freeze({
  id: 'legacy',
  label: 'LangChain Agent Adapter',
  async run({ request, capabilities, capabilityPolicy, limits, signal, emit }) {
    if (signal?.aborted) throw signal.reason || new Error('Harness Run aborted.');
    emit({ type: 'adapter/started', data: { adapter: 'legacy' } });
    const result = await runToolAgent({
      ...request,
      capabilities,
      capabilityPolicy,
      // C-10: the Run's token budget has to reach this path too. It used to be
      // handed only to the DeepSeek SDK, so a legacy Run was effectively
      // unbounded on tokens.
      limits,
      signal
    });
    if (!result.ok) {
      throw new HarnessRuntimeError(502, 'LEGACY_AGENT_ERROR', result.reply || 'Legacy Agent failed.', undefined, { retryable: true });
    }
    emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: result.reply || '' }] } } });
    emit({ type: 'turn/end', data: { reason: { kind: result.ok ? 'stop' : 'error', error: result.ok ? undefined : { message: result.reply } } } });
    return {
      ...result,
      finalResponse: result.reply || '',
      events: result.events || [],
      sessionId: result.sessionId || `legacy-${Date.now()}`
    };
  }
});
