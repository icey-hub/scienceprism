import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectRoot } from '../projectService.js';
import { readHubJson, withHubLock, writeHubJson } from '../projectHub/repository.js';

const FILE = 'constraint-proposals.json';
const KINDS = new Set(['reply.forbid_text', 'patch.forbid_path', 'patch.forbid_text']);

export class ConstraintProposalError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function checkedSpec(input) {
  if (typeof input?.kind !== 'string' || typeof input?.value !== 'string' || typeof input?.statement !== 'string') {
    throw new ConstraintProposalError(400, 'INVALID_PROPOSAL', 'The proposal must contain string kind, value, and statement fields.');
  }
  const kind = String(input?.kind || '').trim();
  const value = String(input?.value || '').trim();
  const statement = String(input?.statement || '').trim();
  if (!KINDS.has(kind)) throw new ConstraintProposalError(400, 'UNSUPPORTED_CONSTRAINT', 'Only reply.forbid_text, patch.forbid_path, and patch.forbid_text can be enforced.');
  if (!statement || statement.length > 240) throw new ConstraintProposalError(400, 'INVALID_STATEMENT', 'A short constraint statement is required.');
  if (value.length < 2 || value.length > 120 || /[\r\n\0]/.test(value)) throw new ConstraintProposalError(400, 'INVALID_VALUE', 'The constraint value must be 2–120 characters on one line.');
  if (kind === 'patch.forbid_path' && (value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new ConstraintProposalError(400, 'INVALID_PATH', 'The blocked path must be a safe project-relative path.');
  }
  return { kind, value, statement };
}

/** A deterministic source and regression-test draft; model-supplied JavaScript is never accepted. */
export function compileConstraintDraft(input) {
  const spec = checkedSpec(input);
  const literal = JSON.stringify(spec.value);
  const condition = spec.kind === 'patch.forbid_path'
    ? `(String(context.path || '') === ${literal} || String(context.path || '').startsWith(${literal} + '/'))`
    : `String(context.${spec.kind === 'reply.forbid_text' ? 'reply' : 'content'} || '').toLocaleLowerCase().includes(${literal}.toLocaleLowerCase())`;
  const subject = spec.kind === 'reply.forbid_text' ? 'reply' : spec.kind === 'patch.forbid_path' ? 'path' : 'content';
  return {
    code: `export function enforce(context) {\n  if (${condition}) throw new Error('PROJECT_CONSTRAINT_VIOLATION');\n}\n`,
    test: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { enforce } from './constraint.mjs';\n\ntest('approved constraint blocks ${subject}', () => {\n  assert.throws(() => enforce({ ${subject}: ${literal} }), /PROJECT_CONSTRAINT_VIOLATION/);\n  assert.doesNotThrow(() => enforce({ ${subject}: '' }));\n});\n`
  };
}

async function codeFile(projectId, proposalId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposalId)) {
    throw new ConstraintProposalError(400, 'INVALID_PROPOSAL_ID', 'Invalid constraint proposal ID.');
  }
  const root = await getProjectRoot(projectId);
  return path.join(root, '.scienceprism', 'approved-constraints', proposalId, 'constraint.mjs');
}

async function loadApprovedCode(projectId, proposal) {
  const file = await codeFile(projectId, proposal.id);
  const expected = compileConstraintDraft(proposal);
  let actual;
  try { actual = await fs.readFile(file, 'utf8'); }
  catch { throw new ConstraintProposalError(500, 'APPROVED_CONSTRAINT_MISSING', 'Approved constraint code is missing.'); }
  if (actual !== expected.code) throw new ConstraintProposalError(500, 'APPROVED_CONSTRAINT_TAMPERED', 'Approved constraint code does not match the reviewed template.');
  return import(pathToFileURL(file).href);
}

async function document(projectId) {
  const stored = await readHubJson(projectId, FILE, () => ({ version: 1, proposals: [] }));
  if (!Array.isArray(stored.proposals)) throw new ConstraintProposalError(500, 'PROPOSALS_UNREADABLE', 'Constraint proposal store is malformed.');
  return stored;
}

export async function listConstraintProposals(projectId) {
  return (await document(projectId)).proposals;
}

export async function createConstraintProposal(projectId, input, { model = null, conversation = '' } = {}) {
  const spec = checkedSpec(input);
  const draft = compileConstraintDraft(spec);
  return withHubLock(projectId, async () => {
    const stored = await document(projectId);
    const existing = stored.proposals.find((item) => item.kind === spec.kind && item.value === spec.value && item.status !== 'rejected');
    if (existing) return existing;
    const at = new Date().toISOString();
    const proposal = {
      id: randomUUID(), ...spec, ...draft, status: 'pending', enabled: false,
      provenance: { source: 'ai-chat', model, conversationExcerpt: String(conversation).slice(-500), createdAt: at },
      audit: [{ action: 'propose', actor: 'ai', at }]
    };
    stored.proposals.unshift(proposal);
    await writeHubJson(projectId, FILE, stored);
    return proposal;
  });
}

export async function reviseConstraintProposal(projectId, proposalId, input, { actor } = {}) {
  if (actor !== 'human') throw new ConstraintProposalError(403, 'HUMAN_DECISION_REQUIRED', 'Only a human may revise a constraint proposal.');
  const spec = checkedSpec(input);
  return withHubLock(projectId, async () => {
    const stored = await document(projectId);
    const proposal = stored.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new ConstraintProposalError(404, 'PROPOSAL_NOT_FOUND', 'Constraint proposal not found.');
    if (proposal.status !== 'pending') throw new ConstraintProposalError(409, 'ALREADY_DECIDED', 'Only pending proposals can be revised.');
    const duplicate = stored.proposals.find((item) => item.id !== proposalId && item.kind === spec.kind && item.value === spec.value && item.status !== 'rejected');
    if (duplicate) throw new ConstraintProposalError(409, 'DUPLICATE_PROPOSAL', 'A proposal for this rule already exists.');
    const previous = { kind: proposal.kind, value: proposal.value, statement: proposal.statement };
    Object.assign(proposal, spec, compileConstraintDraft(spec));
    proposal.audit.push({ action: 'revise', actor, at: new Date().toISOString(), previous });
    await writeHubJson(projectId, FILE, stored);
    return proposal;
  });
}

export async function decideConstraintProposal(projectId, proposalId, { decision, actor, enabled } = {}) {
  if (actor !== 'human') throw new ConstraintProposalError(403, 'HUMAN_DECISION_REQUIRED', 'A human must decide whether a proposed constraint takes effect.');
  if (!['accept', 'reject', 'enable', 'disable'].includes(decision)) throw new ConstraintProposalError(400, 'INVALID_DECISION', 'Decision must be accept, reject, enable, or disable.');
  return withHubLock(projectId, async () => {
    const stored = await document(projectId);
    const proposal = stored.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new ConstraintProposalError(404, 'PROPOSAL_NOT_FOUND', 'Constraint proposal not found.');
    if (decision === 'accept' || decision === 'reject') {
      if (proposal.status !== 'pending') throw new ConstraintProposalError(409, 'ALREADY_DECIDED', 'This proposal already has a decision.');
      proposal.status = decision === 'accept' ? 'accepted' : 'rejected';
      proposal.enabled = decision === 'accept' && enabled !== false;
      if (decision === 'accept') {
        const file = await codeFile(projectId, proposal.id);
        const draft = compileConstraintDraft(proposal);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, draft.code, 'utf8');
        await fs.writeFile(path.join(path.dirname(file), 'constraint.test.mjs'), draft.test, 'utf8');
        const module = await loadApprovedCode(projectId, proposal);
        const subject = proposal.kind === 'reply.forbid_text' ? { reply: proposal.value } : proposal.kind === 'patch.forbid_path' ? { path: proposal.value } : { content: proposal.value };
        let rejected = false;
        try { module.enforce(subject); } catch (error) { rejected = error?.message === 'PROJECT_CONSTRAINT_VIOLATION'; }
        if (!rejected) throw new ConstraintProposalError(500, 'CONSTRAINT_TEST_FAILED', 'Generated constraint failed its rejection check.');
        try { module.enforce({ reply: '', path: '', content: '' }); }
        catch { throw new ConstraintProposalError(500, 'CONSTRAINT_TEST_FAILED', 'Generated constraint blocked an unrelated example.'); }
      }
    } else {
      if (proposal.status !== 'accepted') throw new ConstraintProposalError(409, 'NOT_ACCEPTED', 'Only an accepted constraint can be toggled.');
      if (decision === 'enable') await loadApprovedCode(projectId, proposal);
      proposal.enabled = decision === 'enable';
    }
    proposal.audit.push({ action: decision, actor, at: new Date().toISOString() });
    await writeHubJson(projectId, FILE, stored);
    return proposal;
  });
}

export async function assertApprovedConstraint(projectId, context) {
  const active = (await listConstraintProposals(projectId)).filter((item) => item.status === 'accepted' && item.enabled && item.kind === context.kind);
  for (const spec of active) {
    const module = await loadApprovedCode(projectId, spec);
    try { module.enforce(context); }
    catch (error) {
      if (error?.message !== 'PROJECT_CONSTRAINT_VIOLATION') throw error;
      throw new ConstraintProposalError(403, 'PROJECT_CONSTRAINT_VIOLATION', `Approved project constraint blocked this ${context.kind.startsWith('reply') ? 'reply' : 'Patch'}: ${spec.statement}`);
    }
  }
}
