import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', 'src');

const {
  AGENT_ROLES,
  ENFORCEMENT_MODULES,
  ROLE_AUTHORITIES,
  getRole,
  listRoles,
  renderRoleTable,
  resolveRoleCapabilities,
  roleCatalog
} = await import('../src/services/agentRoles/index.js');
const { HARNESS_CAPABILITIES } = await import('../src/services/harnessRuntime/capabilities.js');

test('every role is well formed and uniquely identified', () => {
  const ids = AGENT_ROLES.map((role) => role.id);
  assert.equal(new Set(ids).size, ids.length, 'role ids must be unique');

  for (const role of AGENT_ROLES) {
    assert.match(role.id, /^[a-z][a-z0-9-]+$/, `unexpected role id: ${role.id}`);
    assert.ok(role.purpose.length > 20, `${role.id}: purpose must actually describe the role`);
    assert.ok(ROLE_AUTHORITIES.includes(role.authority), `${role.id}: unknown authority ${role.authority}`);
    assert.ok(Array.isArray(role.stageScope) && role.stageScope.length > 0, `${role.id}: stageScope is required`);
    assert.ok(Array.isArray(role.forbiddenActions) && role.forbiddenActions.length > 0, `${role.id}: forbidden actions are required`);
    assert.ok(typeof role.handoff === 'string' && role.handoff.length > 10, `${role.id}: handoff is required`);
    assert.ok(typeof role.outputContract === 'string' && role.outputContract.length > 0, `${role.id}: output contract is required`);
    assert.ok(Array.isArray(role.entrypoints) && role.entrypoints.length > 0, `${role.id}: at least one entrypoint is required`);
  }
});

test('a role may only narrow the capability vocabulary, never extend it', () => {
  for (const role of AGENT_ROLES) {
    for (const capability of role.allowedCapabilities) {
      assert.ok(
        HARNESS_CAPABILITIES.includes(capability),
        `${role.id}: ${capability} is not a grantable capability`
      );
    }
  }

  // The read-only roles must not be able to write or execute anything.
  for (const id of ['editor-chat-assistant', 'paper-reviewer', 'research-stage-assistant', 'experiment-interpreter']) {
    const role = getRole(id);
    assert.ok(!role.allowedCapabilities.includes('patch.propose'), `${id} must not hold patch.propose`);
    assert.ok(!role.allowedCapabilities.includes('experiment.execute'), `${id} must not hold experiment.execute`);
  }

  // Only the gated plot role may execute anything.
  const executors = AGENT_ROLES.filter((role) => role.allowedCapabilities.includes('experiment.execute')).map((role) => role.id);
  assert.deepEqual(executors, ['plot-code-generator']);
});

test('every role entrypoint really exists and exports the named symbol', async () => {
  for (const role of AGENT_ROLES) {
    for (const entrypoint of role.entrypoints) {
      const absolute = path.join(srcRoot, entrypoint.module);
      const module = await import(absolute).catch((error) => {
        throw new Error(`${role.id}: cannot import ${entrypoint.module} — ${error.message}`);
      });
      assert.notEqual(
        module[entrypoint.symbol],
        undefined,
        `${role.id}: ${entrypoint.module} does not export ${entrypoint.symbol}`
      );
    }
  }
});

test('the enforcement Modules are not modelled as roles', () => {
  const roleIds = new Set(AGENT_ROLES.map((role) => role.id));
  for (const enforcement of ENFORCEMENT_MODULES) {
    assert.ok(!roleIds.has(enforcement.id), `${enforcement.id} enforces rules and must not carry an AI authority level`);
    assert.ok(enforcement.enforces.length > 10, `${enforcement.id}: describe what it enforces`);
  }
});

test('role resolution narrows the project policy and never widens it', () => {
  const everything = { granted: [...HARNESS_CAPABILITIES] };

  const reviewer = resolveRoleCapabilities('paper-reviewer', everything);
  assert.deepEqual(reviewer.granted, ['project.read']);
  assert.deepEqual(reviewer.denied.sort(), ['experiment.execute', 'patch.propose', 'research.search']);
  assert.deepEqual(reviewer.outOfVocabulary, []);

  const narrower = resolveRoleCapabilities('project-agent', { granted: ['project.read'] });
  assert.deepEqual(narrower.granted, ['project.read'], 'the intersection is taken, not the role list');

  const unknown = resolveRoleCapabilities('no-such-role', everything);
  assert.equal(unknown.role, null);
  assert.equal(unknown.reason, 'UNKNOWN_ROLE');
  assert.deepEqual(unknown.granted, []);

  // A role can never surface a capability the project did not grant.
  for (const role of AGENT_ROLES) {
    const resolved = resolveRoleCapabilities(role.id, { granted: ['project.read'] });
    assert.ok(resolved.granted.every((capability) => capability === 'project.read'));
  }
});

test('the role registry exposes consistent projections', () => {
  const catalog = roleCatalog();
  assert.equal(catalog.total, AGENT_ROLES.length);
  assert.equal(Object.values(catalog.byAuthority).reduce((sum, value) => sum + value, 0), catalog.total);
  assert.equal(catalog.entrypointCount, AGENT_ROLES.reduce((sum, role) => sum + role.entrypoints.length, 0));
  assert.deepEqual(catalog.enforcementModules, ENFORCEMENT_MODULES.map((entry) => entry.id));

  assert.equal(listRoles({ authority: 'suggest-only' }).every((role) => role.authority === 'suggest-only'), true);
  assert.ok(listRoles({ stage: 'writing' }).some((role) => role.id === 'research-stage-assistant'));
  assert.equal(getRole('nope'), null);

  const rendered = renderRoleTable();
  for (const role of AGENT_ROLES) {
    assert.ok(rendered.includes(`\`${role.id}\``), `rendered role table is missing ${role.id}`);
  }
});
