import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

await mkdir(path.join(process.cwd(), '.cache'), { recursive: true });
const dataDir = await mkdtemp(path.join(process.cwd(), '.cache', 'constraint-proposals-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;

const { assertApprovedConstraint, compileConstraintDraft, createConstraintProposal, decideConstraintProposal, listConstraintProposals } = await import('../src/services/constraintRegistry/proposals.js');
const { applyHarnessRunPatches, decideHarnessRun, runHarnessRequest } = await import('../src/services/harnessRuntime/index.js');
const { parseConstraintChatEnvelope } = await import('../src/services/constraintRegistry/chatEnvelope.js');
const { registerConstraintProposalRoutes } = await import('../src/routes/constraintProposals.js');
const { registerAgentRoutes } = await import('../src/routes/agent.js');

async function project(id) {
  const root = path.join(dataDir, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), '{}\n');
  await writeFile(path.join(root, 'main.tex'), 'old\n');
  return root;
}

test('AI proposals are inert until human acceptance, and can be disabled with an audit trail', async () => {
  const id = 'proposal-decision';
  const root = await project(id);
  const proposal = await createConstraintProposal(id, { kind: 'reply.forbid_text', value: 'fabricated', statement: 'Do not present fabricated claims.' }, { model: 'fake', conversation: 'Please do not fabricate claims.' });
  assert.equal(proposal.status, 'pending');
  assert.match(proposal.code, /export function enforce/);
  assert.match(proposal.test, /assert\.throws/);
  await assertApprovedConstraint(id, { kind: 'reply.forbid_text', reply: 'Fabricated claim' });
  await assert.rejects(() => decideConstraintProposal(id, proposal.id, { decision: 'accept', actor: 'ai' }), { code: 'HUMAN_DECISION_REQUIRED' });
  await decideConstraintProposal(id, proposal.id, { decision: 'accept', actor: 'human' });
  await assert.rejects(() => assertApprovedConstraint(id, { kind: 'reply.forbid_text', reply: 'Fabricated claim' }), { code: 'PROJECT_CONSTRAINT_VIOLATION' });
  await decideConstraintProposal(id, proposal.id, { decision: 'disable', actor: 'human' });
  await assertApprovedConstraint(id, { kind: 'reply.forbid_text', reply: 'Fabricated claim' });
  const stored = (await listConstraintProposals(id))[0];
  assert.deepEqual(stored.audit.map((entry) => entry.action), ['propose', 'accept', 'disable']);
  const file = path.join(root, '.scienceprism', 'approved-constraints', proposal.id, 'constraint.mjs');
  assert.equal(await readFile(file, 'utf8'), proposal.code, 'the approved source is the reviewed draft');
  await decideConstraintProposal(id, proposal.id, { decision: 'enable', actor: 'human' });
  await writeFile(file, 'export function enforce() {}\n');
  await assert.rejects(() => assertApprovedConstraint(id, { kind: 'reply.forbid_text', reply: 'Fabricated claim' }), { code: 'APPROVED_CONSTRAINT_TAMPERED' });
  await decideConstraintProposal(id, proposal.id, { decision: 'disable', actor: 'human' });
  await assert.rejects(() => decideConstraintProposal(id, proposal.id, { decision: 'enable', actor: 'human' }), { code: 'APPROVED_CONSTRAINT_TAMPERED' });
});

test('unsupported or unsafe model rules cannot become executable source', () => {
  assert.throws(() => compileConstraintDraft({ kind: 'arbitrary.js', value: 'process.exit()', statement: 'Run code.' }), { code: 'UNSUPPORTED_CONSTRAINT' });
  assert.throws(() => compileConstraintDraft({ kind: 'patch.forbid_path', value: '../secret', statement: 'Block host files.' }), { code: 'INVALID_PATH' });
  const draft = compileConstraintDraft({ kind: 'reply.forbid_text', value: "x'); process.exit()", statement: 'Block a literal phrase.' });
  assert.match(draft.code, /process\.exit/);
  assert.match(draft.code, /"x'\); process\.exit\(\)"/);
});

test('chat envelope extracts one proposal and preserves ordinary replies', () => {
  assert.deepEqual(parseConstraintChatEnvelope('{"reply":"Understood","constraintProposal":{"kind":"patch.forbid_path","value":"main.tex","statement":"Do not edit the manuscript."}}'), {
    reply: 'Understood', proposal: { kind: 'patch.forbid_path', value: 'main.tex', statement: 'Do not edit the manuscript.' }
  });
  assert.deepEqual(parseConstraintChatEnvelope('A normal answer.'), { reply: 'A normal answer.', proposal: null });
});

test('proposal decision API refuses AI approval and shows accepted state', async () => {
  const id = 'proposal-api';
  await project(id);
  const proposal = await createConstraintProposal(id, { kind: 'patch.forbid_path', value: 'main.tex', statement: 'Keep the manuscript untouched.' });
  const app = Fastify();
  registerConstraintProposalRoutes(app);
  const url = `/api/projects/${id}/constraint-proposals`;
  const denied = await app.inject({ method: 'POST', url: `${url}/${proposal.id}/decision`, payload: { decision: 'accept', actor: 'ai' } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'HUMAN_DECISION_REQUIRED');
  const accepted = await app.inject({ method: 'POST', url: `${url}/${proposal.id}/decision`, payload: { decision: 'accept', actor: 'human' } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().proposal.enabled, true);
  const listed = await app.inject({ method: 'GET', url });
  assert.equal(listed.json().proposals[0].status, 'accepted');
  await app.close();
});

test('chat proposes a constraint, but only human acceptance makes it block later replies', async () => {
  const id = 'proposal-chat-flow';
  await project(id);
  let modelReply = JSON.stringify({ reply: 'I can keep that rule for review.', constraintProposal: { kind: 'reply.forbid_text', value: 'fabricated', statement: 'Do not use the word fabricated in replies.' } });
  const app = Fastify();
  registerAgentRoutes(app, { callModel: async () => ({ ok: true, content: modelReply }) });
  registerConstraintProposalRoutes(app);
  const chat = () => app.inject({ method: 'POST', url: '/api/agent/run', payload: { projectId: id, interaction: 'chat', prompt: 'Never use the word fabricated.', history: [] } });
  const first = (await chat()).json();
  assert.equal(first.ok, true);
  assert.equal(first.constraintProposal.status, 'pending');
  modelReply = JSON.stringify({ reply: 'This is a fabricated claim.', constraintProposal: null });
  assert.equal((await chat()).json().ok, true, 'an unapproved proposal has no effect');
  const base = `/api/projects/${id}/constraint-proposals`;
  const accepted = await app.inject({ method: 'POST', url: `${base}/${first.constraintProposal.id}/decision`, payload: { decision: 'accept', actor: 'human' } });
  assert.equal(accepted.json().proposal.enabled, true);
  const blocked = (await chat()).json();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.constraintError.code, 'PROJECT_CONSTRAINT_VIOLATION');
  await app.close();
});

test('an approved path constraint blocks accepted Harness patches before any file is written', async () => {
  const id = 'proposal-patch';
  const root = await project(id);
  await writeFile(path.join(root, 'first.tex'), 'first-old\n');
  const proposal = await createConstraintProposal(id, { kind: 'patch.forbid_path', value: 'main.tex', statement: 'Do not edit the manuscript.' });
  const result = await runHarnessRequest({ projectId: id, adapter: 'fake', task: 'edit', capabilities: ['project.read', 'patch.propose'], fakeResponse: 'done', fakePatches: [{ path: 'first.tex', original: 'first-old\n', content: 'first-new\n', diff: 'diff' }, { path: 'main.tex', original: 'old\n', content: 'new\n', diff: 'diff' }] });
  await decideHarnessRun(id, result.runId, { decision: 'accept', actor: 'human' });
  await decideConstraintProposal(id, proposal.id, { decision: 'accept', actor: 'human' });
  await assert.rejects(() => applyHarnessRunPatches(id, result.runId, { actor: 'human' }), { code: 'PROJECT_CONSTRAINT_VIOLATION' });
  assert.equal(await readFile(path.join(root, 'first.tex'), 'utf8'), 'first-old\n', 'a later blocked Patch must prevent earlier writes');
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
  await decideConstraintProposal(id, proposal.id, { decision: 'disable', actor: 'human' });
  await applyHarnessRunPatches(id, result.runId, { actor: 'human' });
  assert.equal(await readFile(path.join(root, 'first.tex'), 'utf8'), 'first-new\n');
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'new\n');
});

test('an approved writing-text constraint blocks a forbidden phrase in a Harness patch', async () => {
  const id = 'proposal-content';
  const root = await project(id);
  const proposal = await createConstraintProposal(id, { kind: 'patch.forbid_text', value: 'state of the art', statement: 'Do not make an unsupported state of the art claim.' });
  const result = await runHarnessRequest({ projectId: id, adapter: 'fake', task: 'edit', capabilities: ['project.read', 'patch.propose'], fakeResponse: 'done', fakePatches: [{ path: 'main.tex', original: 'old\n', content: 'This is state of the art.\n', diff: 'diff' }] });
  await decideHarnessRun(id, result.runId, { decision: 'accept', actor: 'human' });
  await decideConstraintProposal(id, proposal.id, { decision: 'accept', actor: 'human' });
  await assert.rejects(() => applyHarnessRunPatches(id, result.runId, { actor: 'human' }), { code: 'PROJECT_CONSTRAINT_VIOLATION' });
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'old\n');
  await decideConstraintProposal(id, proposal.id, { decision: 'disable', actor: 'human' });
  await applyHarnessRunPatches(id, result.runId, { actor: 'human' });
  assert.equal(await readFile(path.join(root, 'main.tex'), 'utf8'), 'This is state of the art.\n');
});
