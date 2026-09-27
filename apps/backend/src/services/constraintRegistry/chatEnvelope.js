/** Chat keeps a normal reply while allowing one optional, reviewable constraint suggestion. */
export function parseConstraintChatEnvelope(content) {
  const raw = String(content || '').trim();
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.reply === 'string') {
      const candidate = parsed.constraintProposal;
      return {
        reply: parsed.reply,
        proposal: candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null
      };
    }
  } catch { /* Older/plain responses remain readable. */ }
  return { reply: raw, proposal: null };
}
