import { callOpenAICompatible } from '../services/llmService.js';
import { getAgentRuntimeStatus, runAgentRuntime } from '../services/agentRuntime.js';
import { getLang, t } from '../i18n/index.js';

export function registerAgentRoutes(fastify) {
  fastify.get('/api/agent/runtime', async (req) => {
    return { ok: true, ...getAgentRuntimeStatus(req.query || {}) };
  });

  fastify.post('/api/agent/run', async (req) => {
    const lang = getLang(req);
    const {
      task = 'polish',
      prompt = '',
      selection = '',
      content = '',
      mode = 'direct',
      projectId,
      activePath,
      compileLog,
      llmConfig,
      interaction = 'agent',
      history = []
    } = req.body || {};

    if (interaction === 'chat') {
      const safeHistory = Array.isArray(history)
        ? history.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        : [];
      const system = [
        'You are a helpful academic writing assistant.',
        'This is chat-only mode: do not propose edits, patches, or JSON.',
        'Respond concisely and helpfully.'
      ].join(' ');
      const user = [
        prompt ? `User Prompt: ${prompt}` : '',
        selection ? `Selection (read-only):\n${selection}` : '',
        selection ? '' : (content ? `Current File (read-only):\n${content}` : ''),
        compileLog ? `Compile Log (read-only):\n${compileLog}` : ''
      ].filter(Boolean).join('\n\n');

      const result = await callOpenAICompatible({
        messages: [{ role: 'system', content: system }, ...safeHistory, { role: 'user', content: user }],
        model: llmConfig?.model,
        endpoint: llmConfig?.endpoint,
        apiKey: llmConfig?.apiKey
      });

      if (!result.ok) {
        return {
          ok: false,
          reply: t(lang, 'llm_error', { error: result.error || 'unknown error' }),
          suggestion: ''
        };
      }

      return { ok: true, reply: result.content || '', suggestion: '' };
    }

    if (mode === 'tools') {
      return runAgentRuntime({ projectId, activePath, task, prompt, selection, compileLog, llmConfig, lang });
    }

    const system =
      task === 'autocomplete'
        ? [
            'You are an autocomplete engine for LaTeX.',
            'Only return JSON with keys: reply, suggestion.',
            'suggestion must be the continuation text after the cursor.',
            'Do not include explanations or code fences.'
          ].join(' ')
        : [
            'You are a LaTeX writing assistant for academic papers.',
            'Return a concise response and a suggested rewrite for the selection or full content.',
            'Output in JSON with keys: reply, suggestion.'
          ].join(' ');

    const user = [
      `Task: ${task}`,
      mode === 'tools' ? 'Mode: tools (use extra reasoning)' : 'Mode: direct',
      prompt ? `User Prompt: ${prompt}` : '',
      selection ? `Selection:\n${selection}` : '',
      selection ? '' : `Full Content:\n${content}`
    ].filter(Boolean).join('\n\n');

    const result = await callOpenAICompatible({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      model: llmConfig?.model,
      endpoint: llmConfig?.endpoint,
      apiKey: llmConfig?.apiKey
    });

    if (!result.ok) {
      return {
        ok: false,
        reply: t(lang, 'llm_error', { error: result.error || 'unknown error' }),
        suggestion: ''
      };
    }

    let reply = '';
    let suggestion = '';
    try {
      const parsed = JSON.parse(result.content);
      reply = parsed.reply || '';
      suggestion = parsed.suggestion || '';
    } catch {
      reply = result.content;
    }

    return { ok: true, reply, suggestion };
  });
}
