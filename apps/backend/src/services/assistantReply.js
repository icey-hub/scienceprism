import { parseConstraintChatEnvelope } from './constraintRegistry/chatEnvelope.js';
import { assertApprovedConstraint, createConstraintProposal, ConstraintProposalError } from './constraintRegistry/proposals.js';

/** Finalize before a Run is marked completed so history and policy agree. */
export async function finalizeAssistantReply(projectId, request, result) {
  if (request.source !== 'editor') return result;
  const envelope = parseConstraintChatEnvelope(result.finalResponse || result.reply || '');
  await assertApprovedConstraint(projectId, { kind: 'reply.forbid_text', reply: envelope.reply });
  const output = { ...result, finalResponse: envelope.reply, reply: envelope.reply };
  if (envelope.proposal) {
    try {
      output.constraintProposal = await createConstraintProposal(projectId, envelope.proposal, {
        model: request.llmConfig?.model, conversation: request.prompt
      });
    } catch (error) {
      if (!(error instanceof ConstraintProposalError)) throw error;
      output.constraintProposalError = { code: error.code, message: error.message };
    }
  } else if (/约束|规则|以后|每次|永远|不许|不要再|\bnever\b|\balways\b|\bconstraint\b|\brule\b/i.test(request.prompt || '')) {
    output.constraintProposalError = { code: 'NO_ENFORCEABLE_PROPOSAL', message: '没有生成可执行规则；目前支持禁止回复词句、修改词句或项目路径。' };
  }
  return output;
}
