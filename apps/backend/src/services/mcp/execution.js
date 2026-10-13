import { randomUUID, createHash } from 'node:crypto';
import { readMcpConfig, withMcpClient } from './index.js';
import { HarnessRuntimeError } from '../harnessRuntime/errors.js';
import { createMcpToolPolicy } from './toolPolicy.js';
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
export const mcpCheckAdapter={id:'mcp',label:'Explicit read-only MCP check',async run({request,capabilityPolicy,signal,emit,readPolicy,onDecision}){
 const call=structuredClone(request.mcpCall);
 if(!call||typeof call.arguments!=='object'||!call.arguments||Array.isArray(call.arguments)||JSON.stringify(call.arguments).length>20000)throw new HarnessRuntimeError(400,'MCP_ARGUMENTS_INVALID','Tool arguments must be a bounded JSON object.');
 const policy=await createMcpToolPolicy({projectId:request.projectId,role:request.role,task:request.task,capabilityPolicy,signal,readPolicy,onDecision});
 const context={role:request.role,task:request.task,granted:(await readPolicy()).capabilities.granted};
 const selected=await resolveMcpTool(request.projectId,call,context);
 const callId=randomUUID(),name=selected.tool.publicName;
 const admission=await policy.admit({callId,tool:name,schema:selected.tool.inputSchema,arguments:call.arguments,serverId:selected.server.id,serverVersion:selected.version});
 const guard=async(effects={})=>{
   const capabilities=await admission.recheck(effects);
   const current=await resolveMcpTool(request.projectId,call,{...context,granted:capabilities.granted});
   if(current.version!==selected.version||digest(current.server)!==digest(selected.server))throw deny('MCP_CONFIG_CHANGED','MCP configuration changed before dispatch.');
   signal?.throwIfAborted();return capabilities;
 };
 const capabilities=await guard(selected.server.transport==='streamable-http'?{url:selected.server.url}:{});
 let output;
 try{output=await withMcpClient(request.projectId,selected.server,async(client,requestSignal)=>{
   const available=(await client.listTools(undefined,{timeout:8000,signal:requestSignal})).tools.find(tool=>tool.name===call.toolName);
   if(!available?.annotations?.readOnlyHint||digest(available.inputSchema)!==digest(selected.tool.inputSchema))throw deny('MCP_SCHEMA_CHANGED','Tool schema or read-only declaration changed; discover again.');
   await guard();requestSignal.throwIfAborted();
   emit({type:'tool/start',data:{name,callId,arguments:call.arguments}});
   try {const result=await client.callTool({name:call.toolName,arguments:call.arguments},{timeout:8000,signal:requestSignal});
     await guard();requestSignal.throwIfAborted();
     if(result.isError)throw new HarnessRuntimeError(502,'MCP_TOOL_ERROR','MCP server reported a tool error.');
     if(Buffer.byteLength(JSON.stringify(result))>1_000_000)throw new HarnessRuntimeError(413,'MCP_OUTPUT_TOO_LARGE','MCP tool output exceeds its limit.');
     emit({type:'tool/end',data:{name,callId,output:result}});return result;
   }catch(error){emit({type:'tool/error',data:{name,callId,error:{message:error.message,code:error.code}}});throw error;}
 },{signal,beforeRequest:guard,capabilityPolicy:capabilities,copyProject:true,
   onProcess:process=>onDecision({type:'mcp/process',...process})});
 }catch(error){try{await admission.deny(error);}catch(auditError){if(error.code!=='MCP_STOP_FAILED')throw auditError;}throw error;}
 try{await guard();}catch(error){await admission.deny(error);throw error;}
 return {ok:true,finalResponse:JSON.stringify(output),usage:null,patches:[]};
}};
