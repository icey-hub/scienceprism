import { randomUUID, createHash } from 'node:crypto';
import { readMcpConfig, withMcpClient } from './index.js';
import { HarnessRuntimeError } from '../harnessRuntime/errors.js';
const deny=(code,message)=>new HarnessRuntimeError(403,code,message);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function resolveMcpTool(projectId,call,{role,task,granted=[]}={}){
 const config=await readMcpConfig(projectId),server=config.servers.find(server=>server.id===call?.serverId),tool=server?.discovery?.tools?.find(tool=>tool.name===call?.toolName);
 if(!server?.enabled||server.discovery?.state!=='discovered'||!tool)throw deny('MCP_UNAVAILABLE','Server must be enabled with a successful discovery.');
 if(!server.roles.includes(role)||!server.tasks.includes(task)||!server.tools.includes(tool.name)||!granted.includes(server.capability))throw deny('MCP_BINDING_DENIED','Tool is not bound to this role, task and granted capability.');
 if(!tool.readOnlyHint||!tool.inputSchema)throw deny('MCP_TOOL_RESTRICTED','Only explicitly selected, discovered read-only tools with a bounded schema can be checked.');
 return {server,tool,version:config.version};
}
// SDK notifications occur after execution. Until an isolated DSH guard is proved,
// selected external tools are rejected before the SDK process or MCP transport starts.
export function assertDshMcpPolicy(request){if(request.mcpToolIds?.length||request.mcpCall)throw deny('MCP_DSH_RESTRICTED','DSH automatic MCP execution is restricted: an execution-before-policy bridge has not been verified. Use the explicit read-only tool check.');}
export const mcpCheckAdapter={id:'mcp',label:'Explicit read-only MCP check',async run({request,capabilityPolicy,signal,emit}){
 const call=request.mcpCall;
 if(!call||typeof call.arguments!=='object'||!call.arguments||Array.isArray(call.arguments)||JSON.stringify(call.arguments).length>20000)throw new HarnessRuntimeError(400,'MCP_ARGUMENTS_INVALID','Tool arguments must be a bounded JSON object.');
 const context={role:request.role,task:request.task,granted:capabilityPolicy.granted};
 const selected=await resolveMcpTool(request.projectId,call,context);
 if(selected.server.transport==='streamable-http'&&!capabilityPolicy.networkAllowlist?.includes(new URL(selected.server.url).hostname))throw deny('NETWORK_DENIED','The MCP host is not in the project network allowlist.');
 const callId=randomUUID(),name=selected.tool.publicName;
 const output=await withMcpClient(request.projectId,selected.server,async client=>{
   const current=await resolveMcpTool(request.projectId,call,context);
   if(current.server.updatedAt!==selected.server.updatedAt)throw deny('MCP_CONFIG_CHANGED','MCP configuration changed before dispatch.');
   const available=(await client.listTools(undefined,{timeout:8000,signal})).tools.find(tool=>tool.name===call.toolName);
   if(!available?.annotations?.readOnlyHint||digest(available.inputSchema)!==digest(selected.tool.inputSchema))throw deny('MCP_SCHEMA_CHANGED','Tool schema or read-only declaration changed; discover again.');
   if(signal?.aborted)throw deny('MCP_CANCELLED','MCP check cancelled before dispatch.');
   emit({type:'tool/start',data:{name,callId,arguments:call.arguments}});
   try {const result=await client.callTool({name:call.toolName,arguments:call.arguments},{timeout:8000,signal});if(result.isError)throw new HarnessRuntimeError(502,'MCP_TOOL_ERROR','MCP server reported a tool error.');emit({type:'tool/end',data:{name,callId,output:result}});return result;}catch(error){emit({type:'tool/error',data:{name,callId,error:error.message}});throw error;}
 },{signal});
 return {ok:true,finalResponse:JSON.stringify(output),usage:null,patches:[]};
}};
