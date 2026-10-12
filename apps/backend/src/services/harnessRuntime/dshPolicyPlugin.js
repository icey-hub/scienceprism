import { readFile } from 'node:fs/promises';
import { installDshPolicyBridge } from './dshPolicyBridge.js';
import { DSH_VERSION, DSH_PRODUCT_TOOLS } from './dshProfile.js';

export const name = 'scienceprism-product-policy';
export const inject = ['tools', 'llm'];

// tools.register consumes raw JSON Schema. The SDK's property-map author DSL
// is only compiled by defineTool, and must never be sent to a provider as-is.
export const DSH_TOOL_DEFINITIONS = [
  { name: 'project_read_file', description: 'Read bounded project text and its SHA256, through current project policy.', capability: 'project.read', parameters: {
    type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, fromLine: { type: 'integer' }, toLine: { type: 'integer' } }, required: ['path']
  } },
  { name: 'project_propose_patch', description: 'Propose text in the temporary project copy. Existing files require the SHA256 returned by project_read_file; new files require null. The original project is unchanged.', capability: 'patch.propose', parameters: {
    type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' }, expectedSha256: { oneOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['path', 'content', 'expectedSha256']
  } },
  { name: 'research_delegate_codex', description: 'Delegate a bounded coding task to the controlled Codex CLI worker. It returns the real child Run result and proposed changes; it cannot choose a provider, commands, directories, roles or permissions.', capability: 'patch.propose', parameters: {
    type: 'object', additionalProperties: false, properties: { task: { type: 'string' }, maxTokens: { type: 'integer' }, timeoutMs: { type: 'integer' } }, required: ['task']
  } }
];

export async function apply(ctx, options) {
  const config = JSON.parse(await readFile(options.configPath, 'utf8'));
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/bridge' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid private DSH bridge configuration.');
  const call = async (message, signal) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }, body: JSON.stringify(message),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs), redirect: 'error' });
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_048_700) throw new Error('Project tool output exceeds the limit.');
    const result = JSON.parse(text);
    if (!response.ok || result.error) throw new Error(`Project tool denied: ${result.error || 'DSH_BRIDGE_FAILED'}`);
    return result.result;
  };
  const definitions = DSH_TOOL_DEFINITIONS;
  const admissions = new WeakMap();
  let booting = true;
  let probeMode = 'auto';
  let calls = 0;
  const probeName = 'scienceprism_private_policy_probe';
  const probePolicy = () => ({ projectId: 'private-boot', runId: 'private-boot', version: 1, role: 'private-boot', task: 'private-boot', active: true, mode: probeMode, capabilities: { granted: ['project.read'], allowedPaths: [], networkAllowlist: [] } });
  const removeProbe = ctx.tools.register({ name: probeName, description: 'Private no-effect policy self-check.', parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { calls += 1; return 'allowed'; } });
  for (const definition of definitions) ctx.tools.register({ ...definition, output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, execution) => call({ method: 'execute', tool: definition.name, callId: execution.callId, arguments: args }, execution.signal) });
  const bindings = definitions.map(definition => ({ name: definition.name, capability: definition.capability, roles: [config.ceiling.role], tasks: [config.ceiling.task], check: execution => {
    const args = execution.arguments;
    const known = Object.keys(definition.parameters.properties);
    return Boolean(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => known.includes(key)));
  } }));
  bindings.push({ name: probeName, capability: 'project.read', roles: ['private-boot'], tasks: ['private-boot'], check: execution => booting && execution.arguments.action === 'allow' });
  const bridge = installDshPolicyBridge(ctx, { readPolicy: execution => admissions.get(execution), bindings });
  // Admission is prepended ahead of the bridge waterfall. The bridge's final
  // monotonic guard still rejects a foreign listener that skips either step.
  ctx.on('tools/pre-execute', async (execution, next) => {
    try { admissions.set(execution, booting && execution.name === probeName ? probePolicy() : await call({ method: 'policy' }, execution.signal)); }
    catch { return { kind: 'deny', reason: 'The current project policy is unavailable.' }; }
    return next();
  }, { prepend: true });
  ctx.on('dispose', () => bridge.close());
  const run = (tool, arguments_, signal = new AbortController().signal) => ctx.tools.execute({ name: tool, callId: `private-boot-${Math.random()}`, arguments: arguments_, signal });
  const denied = [];
  denied.push(await run(probeName, { action: 'deny' }));
  const allowed = await run(probeName, { action: 'allow' });
  const removeBypass = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true });
  denied.push(await run(probeName, { action: 'allow' })); removeBypass();
  probeMode = 'manual'; denied.push(await run(probeName, { action: 'allow' })); probeMode = 'auto';
  const cancelled = new AbortController(); cancelled.abort(); denied.push(await run(probeName, { action: 'allow' }, cancelled.signal));
  denied.push(await run('run_code', { code: 'return 1', description: 'Must not execute PTC' }));
  denied.push(await run('bash', { command: 'must-not-execute' }));
  denied.push(await run('mcp__unbound', {}));
  booting = false;
  removeProbe();
  if (allowed.isError || calls !== 1 || denied.some(result => !result.isError)) throw new Error('DSH product policy self-check failed.');
  if (config.provider && !ctx.llm.listProviders().some(provider => provider.id === config.provider)) throw new Error('The configured compatible provider is unavailable.');
  await call({ method: 'ready', checks: { version: DSH_VERSION, allowedBodyCalls: calls, denied: denied.length, tools: DSH_PRODUCT_TOOLS, ...(config.provider ? { provider: config.provider } : {}) } });
}
