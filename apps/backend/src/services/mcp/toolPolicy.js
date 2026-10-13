import { isDeepStrictEqual } from 'node:util';
import { Ajv, AjvJsonSchemaValidator, addFormats } from '@modelcontextprotocol/client/validators/ajv';
import { assertCapability, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { HarnessRuntimeError } from '../harnessRuntime/errors.js';

const fail = (code, message, status = 403) => new HarnessRuntimeError(status, code, message);
const bounded = (value, limit = 200) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && value.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value);
const version = value => bounded(value) || typeof value === 'number' && Number.isFinite(value);
function jsonCopy(value, bytes, code) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 4096 || depth > 24) throw fail(code, 'The MCP JSON input exceeds its structural limit.', 400);
    if (item === null || typeof item === 'boolean' || typeof item === 'string' && item.isWellFormed() || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw fail(code, 'MCP inputs must contain only bounded JSON values.', 400);
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key), 'value')) throw fail(code, 'MCP JSON input contains an unsupported property.', 400);
      visit(item[key], depth + 1);
    }
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > bytes) throw fail(code, 'The MCP JSON input exceeds its byte limit.', 400);
  return JSON.parse(encoded);
}
function capabilities(value, defaults = false) {
  const result = {};
  for (const key of ['granted', 'allowedPaths', 'networkAllowlist']) {
    const entries = defaults && key !== 'granted' && value?.[key] === undefined ? [] : value?.[key];
    if (!Array.isArray(entries) || entries.length > 2000 || entries.some(entry => !bounded(entry, 4096))) throw fail('MCP_POLICY_UNAVAILABLE', 'The MCP capability scope is invalid.');
    result[key] = [...entries];
  }
  for (const target of result.allowedPaths) {
    if (target.startsWith('/') || /^[A-Za-z]:/.test(target) || target.includes('\\')
      || target.split('/').some(part => !part || ['.', '..'].includes(part)) || isSensitivePath(target)) throw fail('PATH_DENIED', 'MCP requires normalized non-sensitive project scope.');
  }
  return result;
}
function snapshot(value) {
  if (!value || !['projectId', 'runId', 'role', 'task'].every(key => bounded(value[key])) || typeof value.active !== 'boolean'
    || !['auto', 'manual'].includes(value.mode) || !version(value.version)) throw fail('MCP_POLICY_UNAVAILABLE', 'The current MCP Run policy is invalid.');
  return { ...Object.fromEntries(['projectId', 'runId', 'role', 'task', 'active', 'mode', 'version'].map(key => [key, value[key]])), capabilities: capabilities(value.capabilities) };
}
function intersection(scopes) {
  let allowedPaths = [], disjoint = false;
  for (const scope of scopes) {
    const next = scope.allowedPaths;
    const combined = !allowedPaths.length ? next : !next.length ? allowedPaths
      : [...new Set(allowedPaths.flatMap(a => next.flatMap(b => a === b || a.startsWith(`${b}/`) ? [a] : b.startsWith(`${a}/`) ? [b] : [])))];
    disjoint ||= allowedPaths.length > 0 && next.length > 0 && !combined.length; allowedPaths = combined;
  }
  return { granted: scopes[0].granted.filter(value => scopes.every(scope => scope.granted.includes(value))
    && !(disjoint && ['project.read', 'patch.propose'].includes(value))), allowedPaths,
  networkAllowlist: scopes[0].networkAllowlist.filter(host => scopes.every(scope => scope.networkAllowlist.includes(host))) };
}
function schemaValidator(input) {
  const schema = jsonCopy(input, 64 * 1024, 'MCP_SCHEMA_INVALID');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') throw fail('MCP_SCHEMA_INVALID', 'MCP input schema must declare an object.', 400);
  // AJV owns the server's exact JSON Schema semantics. Never load remote refs
  // or invent an additionalProperties rule across compositions/conditions.
  const visit = node => {
    if (typeof node === 'boolean') return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw fail('MCP_SCHEMA_INVALID', 'A declared child schema is invalid.', 400);
    if (node.$async !== undefined || node.$ref !== undefined && (typeof node.$ref !== 'string' || !node.$ref.startsWith('#'))
      || node.$schema !== undefined && node.$schema !== 'http://json-schema.org/draft-07/schema#') throw fail('MCP_SCHEMA_INVALID', 'This MCP schema declaration is unsupported.', 400);
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependencies']) {
      if (node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) for (const child of Object.values(node[key])) {
        if (key !== 'dependencies' || !Array.isArray(child)) visit(child);
      }
    }
    for (const key of ['additionalProperties', 'additionalItems', 'contains', 'propertyNames']) if (node[key] !== undefined) visit(node[key]);
    for (const key of ['not', 'if', 'then', 'else']) if (node[key] !== undefined) visit(node[key]);
    if (node.items !== undefined) { if (Array.isArray(node.items)) node.items.forEach(item => visit(item)); else visit(node.items); }
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(node[key])) node[key].forEach(item => visit(item));
  };
  visit(schema);
  try {
    const ajv = new Ajv({ strict: true, strictTypes: false, strictRequired: false, strictTuples: false, allowUnionTypes: true,
      ownProperties: true, allErrors: false, removeAdditional: false, useDefaults: false, coerceTypes: false });
    addFormats(ajv);
    return new AjvJsonSchemaValidator(ajv).getValidator(schema);
  } catch { throw fail('MCP_SCHEMA_INVALID', 'The MCP schema cannot be strictly validated by this profile.', 400); }
}

/** Selected tool/server binding and isolated transport belong to the executor.
 * This module admits fixed JSON arguments and rechecks trusted dispatch effects. */
export async function createMcpToolPolicy({ projectId, role, task, capabilityPolicy, readPolicy, onDecision, signal } = {}) {
  if (![projectId, role, task].every(value => bounded(value)) || typeof readPolicy !== 'function' || typeof onDecision !== 'function') throw fail('MCP_POLICY_UNAVAILABLE', 'A bound project, role, task and persisted MCP policy are required.');
  const fixed = capabilities(capabilityPolicy, true);
  const read = async () => {
    try { return snapshot(await readPolicy()); }
    catch (reason) { if (reason instanceof HarnessRuntimeError) throw reason; throw fail('MCP_POLICY_UNAVAILABLE', 'The current MCP policy could not be read.'); }
  };
  const ceiling = await read();
  if (ceiling.projectId !== projectId || ceiling.role !== role || ceiling.task !== task) throw fail('MCP_OWNER_CHANGED', 'MCP policy does not belong to this project, role and task.');
  return Object.freeze({ async admit(input) {
    let policy = ceiling;
    const validIdentity = input && typeof input === 'object' && !Array.isArray(input) && bounded(input.callId) && bounded(input.tool) && bounded(input.serverId);
    const auditIdentity = validIdentity ? { tool: input.tool, callId: input.callId, serverId: input.serverId,
      serverVersion: version(input.serverVersion) ? input.serverVersion : null } : {};
    const record = (decision, reasonCode) => onDecision({ type: 'tool/policy', ...auditIdentity, projectId, runId: ceiling.runId, actor: 'system',
      capability: 'project.read', policyVersion: policy.version, decision, ...(reasonCode ? { reasonCode } : {}) });
    const deny = async reason => {
      try { await record('deny', bounded(reason?.code, 100) ? reason.code : 'MCP_TOOL_FAILED'); }
      catch { throw fail('MCP_AUDIT_UNAVAILABLE', 'The MCP policy decision could not be persisted.'); }
    };
    try {
      if (!validIdentity || !version(input.serverVersion) || Object.keys(input).some(key => !['callId', 'tool', 'schema', 'arguments', 'serverId', 'serverVersion'].includes(key))) throw fail('MCP_ARGUMENTS_INVALID', 'A bounded selected MCP call identity is required.', 400);
      const args = jsonCopy(input.arguments, 20000, 'MCP_ARGUMENTS_INVALID');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('MCP_ARGUMENTS_INVALID', 'MCP arguments must be a bounded JSON object.', 400);
      const validate = schemaValidator(input.schema);
      try { if (!validate(args).valid) throw fail('MCP_ARGUMENTS_INVALID', 'MCP arguments do not match the selected tool schema.', 400); }
      catch (reason) { if (reason instanceof HarnessRuntimeError) throw reason; throw fail('MCP_ARGUMENTS_INVALID', 'The MCP arguments cannot be validated.', 400); }
      const bound = { callId: input.callId, tool: input.tool, serverId: input.serverId, serverVersion: input.serverVersion, arguments: args, schema: jsonCopy(input.schema, 64 * 1024, 'MCP_SCHEMA_INVALID') };
      const current = async (admitted, effects = {}) => {
        if (!effects || typeof effects !== 'object' || Array.isArray(effects) || Object.keys(effects).some(key => key !== 'url')) throw fail('MCP_ARGUMENTS_INVALID', 'Only a trusted MCP network effect can be rechecked.', 400);
        if (signal?.aborted) throw fail('MCP_CANCELLED', 'The MCP operation was cancelled.');
        policy = await read();
        if (!policy.active || !ceiling.active) throw fail('MCP_RUN_INACTIVE', 'The owning MCP Run is inactive.');
        if (['projectId', 'runId', 'role', 'task'].some(key => policy[key] !== ceiling[key])) throw fail('MCP_OWNER_CHANGED', 'The MCP operation no longer belongs to its bound Run and role.');
        if (admitted && !isDeepStrictEqual(policy, admitted)) throw fail('MCP_POLICY_CHANGED', 'The MCP admission policy changed before execution.');
        const actual = { callId: input.callId, tool: input.tool, serverId: input.serverId, serverVersion: input.serverVersion,
          arguments: jsonCopy(input.arguments, 20000, 'MCP_ARGUMENTS_INVALID'), schema: jsonCopy(input.schema, 64 * 1024, 'MCP_SCHEMA_INVALID') };
        if (!isDeepStrictEqual(bound, actual)) throw fail('MCP_BINDING_CHANGED', 'The selected MCP tool, schema or arguments changed.');
        const scopes = [fixed, ceiling.capabilities, policy.capabilities], effective = intersection(scopes);
        assertCapability(effective, 'project.read');
        if (effects.url !== undefined) {
          let url;
          try { if (!bounded(effects.url, 8192)) throw new Error(); url = new URL(effects.url); } catch { throw fail('NETWORK_DENIED', 'The trusted MCP transport URL is invalid.'); }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || scopes.some(scope => !scope.networkAllowlist.includes(url.hostname))) throw fail('NETWORK_DENIED', 'The MCP transport host is outside this Run scope.');
        }
        if (signal?.aborted) throw fail('MCP_CANCELLED', 'The MCP operation was cancelled.');
        return structuredClone(effective);
      };
      await current(); const admitted = policy;
      try { await record('allow'); } catch { throw fail('MCP_AUDIT_UNAVAILABLE', 'The MCP policy decision could not be persisted.'); }
      await current(admitted);
      return Object.freeze({ recheck: (effects = {}) => current(admitted, effects), deny });
    } catch (reason) {
      if (validIdentity) { try { await deny(reason); } catch {} }
      throw reason;
    }
  } });
}
