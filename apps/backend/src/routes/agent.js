import { callOpenAICompatible, resolveLLMConfig } from '../services/llmService.js';
import { getAgentRuntimeStatus, runAgentRuntime } from '../services/agentRuntime.js';
import { listRoles, roleCatalog } from '../services/agentRoles/index.js';
import { getLang, t } from '../i18n/index.js';
import { assertApprovedConstraint, createConstraintProposal, ConstraintProposalError } from '../services/constraintRegistry/proposals.js';
import { parseConstraintChatEnvelope } from '../services/constraintRegistry/chatEnvelope.js';
import { listAssistantSkills, startAssistantRun } from '../services/assistantService.js';

async function checkedReply(projectId, response) {
  if (!projectId || !response.ok) return response;
  try {
    await assertApprovedConstraint(projectId, { kind: 'reply.forbid_text', reply: `${response.reply || ''}\n${response.suggestion || ''}` });
    return response;
  } catch (error) {
    if (!(error instanceof ConstraintProposalError)) throw error;
    return { ok: false, reply: error.message, suggestion: '', constraintError: { code: error.code, message: error.message } };
  }
}

export function registerAgentRoutes(fastify, { callModel = callOpenAICompatible } = {}) {
  fastify.get('/api/projects/:id/assistant-skills', async (req, reply) => {
    try {
      return { ok: true, ...(await listAssistantSkills(req.params.id)) };
    } catch (error) {
      return reply.code(error.code === 'ENOENT' ? 404 : error.statusCode || 500).send({ ok: false, error: {
        code: 'SKILL_CATALOG_FAILED', message: 'The project Skill catalog could not be loaded.'
      } });
    }
  });
  fastify.post('/api/projects/:id/assistant-runs', async (req, reply) => {
    try {
      const run = await startAssistantRun(req.params.id, req.body || {});
      return reply.code(202).send({ ok: true, run });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ ok: false, error: {
        code: error.code || 'ASSISTANT_FAILED', message: error.message, details: error.details
      } });
    }
  });
  fastify.get('/api/agent/runtime', async (req) => {
    return { ok: true, ...getAgentRuntimeStatus(req.query || {}) };
  });

  // Visibility before a run: which role acts for a stage, with what authority,
  // which capabilities, and which skills. The registry has existed since
  // iteration 018 but was only reachable from inside the backend.
  fastify.get('/api/agent/roles', async (req) => {
    const stage = typeof req.query?.stage === 'string' && req.query.stage.trim() ? req.query.stage.trim() : undefined;
    const roles = listRoles(stage ? { stage } : {}).map((role) => ({
      id: role.id,
      purpose: role.purpose,
      authority: role.authority,
      capabilities: role.allowedCapabilities,
      skills: role.allowedSkills,
      forbiddenActions: role.forbiddenActions,
      stageScope: role.stageScope
    }));
    return { ok: true, stage: stage || null, catalog: roleCatalog(), roles };
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
      role,
      history = []
    } = req.body || {};

    if (interaction === 'chat') {
      const safeHistory = Array.isArray(history)
        ? history.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        : [];
      const system = [
        'You are a helpful academic writing assistant.',
        'This is chat-only mode: do not propose file edits or patches.',
        'Return one JSON object with reply (a concise helpful answer) and constraintProposal (object or null).',
        'If the user expresses a durable rule for this project, you must propose it when it can be enforced as reply.forbid_text, patch.forbid_path, or patch.forbid_text. The object must have kind, value, and statement. Otherwise set constraintProposal to null.',
        'Do not claim any rule is active. A human must review and accept the generated code and test draft first.'
      ].join(' ');
      const user = [
        prompt ? `User Prompt: ${prompt}` : '',
        selection ? `Selection (read-only):\n${selection}` : '',
        selection ? '' : (content ? `Current File (read-only):\n${content}` : ''),
        compileLog ? `Compile Log (read-only):\n${compileLog}` : ''
      ].filter(Boolean).join('\n\n');

      const result = await callModel({
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

      const envelope = parseConstraintChatEnvelope(result.content);
      const checked = await checkedReply(projectId, { ok: true, reply: envelope.reply, suggestion: '' });
      if (!checked.ok || !projectId) return checked;
      if (!envelope.proposal) {
        const requestedRule = /约束|规则|以后|每次|永远|不许|不要再|\bnever\b|\balways\b|\bconstraint\b|\brule\b/i.test(prompt);
        return requestedRule
          ? { ...checked, constraintProposalError: { code: 'NO_ENFORCEABLE_PROPOSAL', message: 'No supported enforceable rule was proposed. Specify a forbidden reply phrase, Patch phrase, or project-relative Patch path.' } }
          : checked;
      }
      try {
        const proposal = await createConstraintProposal(projectId, envelope.proposal, { model: resolveLLMConfig(llmConfig).model, conversation: prompt });
        return { ...checked, constraintProposal: proposal };
      } catch (error) {
        if (!(error instanceof ConstraintProposalError)) throw error;
        return { ...checked, constraintProposalError: { code: error.code, message: error.message } };
      }
    }

    if (mode === 'tools') {
      // `role` is forwarded so the Runtime can narrow the Run's capabilities to
      // the role's allowance. A read-only task then cannot hold patch.propose
      // merely because its prompt asked the model not to use it, and an unknown
      // role fails closed inside createHarnessRun.
      return checkedReply(projectId, await runAgentRuntime({ projectId, activePath, task, prompt, selection, compileLog, llmConfig, lang, role }));
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

    const result = await callModel({
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

    return checkedReply(projectId, { ok: true, reply, suggestion });
  });
}
