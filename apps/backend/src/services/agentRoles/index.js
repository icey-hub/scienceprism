import { AGENT_ROLES, ENFORCEMENT_MODULES, ROLE_AUTHORITIES } from './roles.js';
import { HARNESS_CAPABILITIES } from '../harnessRuntime/capabilities.js';

export { AGENT_ROLES, ENFORCEMENT_MODULES, ROLE_AUTHORITIES };

/**
 * Read projections over the role registry.
 *
 * Nothing here changes behaviour yet: the registry makes each role's purpose,
 * authority, and forbidden actions explicit so the wiring beat can consume them
 * and the tests can check them.
 */
export function listRoles({ authority, stage } = {}) {
  return AGENT_ROLES.filter((role) => {
    if (authority && role.authority !== authority) return false;
    if (stage && !role.stageScope.includes(stage)) return false;
    return true;
  });
}

export function getRole(id) {
  return AGENT_ROLES.find((role) => role.id === id) || null;
}

export function roleCatalog() {
  const byAuthority = Object.fromEntries(ROLE_AUTHORITIES.map((authority) => [authority, 0]));
  for (const role of AGENT_ROLES) byAuthority[role.authority] = (byAuthority[role.authority] || 0) + 1;
  return {
    total: AGENT_ROLES.length,
    byAuthority,
    enforcementModules: ENFORCEMENT_MODULES.map((entry) => entry.id),
    entrypointCount: AGENT_ROLES.reduce((sum, role) => sum + role.entrypoints.length, 0)
  };
}

/**
 * Narrows a Project's capability policy to what one role is allowed to use.
 *
 * A role can only ever remove capabilities, never add them: the result is the
 * intersection of what the Project granted and what the role permits. Anything
 * the role lists that is outside the capability vocabulary is surfaced rather
 * than silently honoured.
 */
export function resolveRoleCapabilities(roleId, policy) {
  const role = getRole(roleId);
  if (!role) {
    return { role: null, authority: null, granted: [], denied: [], outOfVocabulary: [], reason: 'UNKNOWN_ROLE' };
  }
  const projectGranted = Array.isArray(policy?.granted) ? policy.granted : [];
  const granted = projectGranted.filter((capability) => role.allowedCapabilities.includes(capability));
  return {
    role: role.id,
    authority: role.authority,
    granted,
    denied: projectGranted.filter((capability) => !granted.includes(capability)),
    outOfVocabulary: role.allowedCapabilities.filter((capability) => !HARNESS_CAPABILITIES.includes(capability))
  };
}

/** Renders the registry as Markdown for `docs/agent-governance/agent-roles.md`. */
export function renderRoleTable() {
  const header = [
    '| Role | Purpose | Authority | Stages | Capabilities | Skills |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  const rows = AGENT_ROLES.map((role) => [
    `| \`${role.id}\` | ${role.purpose} | ${role.authority} | ${role.stageScope.join(', ')}`,
    role.allowedCapabilities.length ? role.allowedCapabilities.map((capability) => `\`${capability}\``).join(', ') : 'none',
    role.allowedSkills.length ? role.allowedSkills.map((skill) => `\`${skill}\``).join(', ') : 'none'
  ].join(' | ') + ' |');
  return [...header, ...rows].join('\n');
}
