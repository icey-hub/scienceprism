import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getProjectRoot } from '../projectService.js';
import { getRole } from '../agentRoles/index.js';

const locks=new Map();
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode,code:'MCP_CONFIG_ERROR'});
const list=value=>Array.isArray(value)?[...new Set(value.filter(item=>typeof item==='string'))]:[];
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
function credentials(value){const entries=Object.entries(record(value));if(entries.length>40||entries.some(([key,value])=>!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)||typeof value!=='string'||value.length>4096))throw fail('Invalid environment/header values.');return Object.fromEntries(entries);}
async function rootFile(projectId){let root;try{root=await getProjectRoot(projectId);}catch(error){if(error.code==='ENOENT')throw fail('Project not found.',404);throw error;}return {root,file:path.join(root,'.scienceprism/mcp.json')};}
export async function readMcpConfig(projectId){const {file}=await rootFile(projectId);try{const text=await fs.readFile(file,'utf8');if(text.length>2_000_000)throw fail('MCP config exceeds limit.',500);const value=JSON.parse(text);if(value.schemaVersion!==1||!Array.isArray(value.servers))throw fail('Invalid stored MCP config.',500);return value;}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,version:0,servers:[]};throw error;}}
async function write(projectId,value){const {file}=await rootFile(projectId);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
async function change(projectId,fn){const prior=locks.get(projectId)||Promise.resolve();const work=prior.catch(()=>{}).then(async()=>{const config=await readMcpConfig(projectId);const result=await fn(config);config.version++;await write(projectId,config);return result;});locks.set(projectId,work);try{return await work;}finally{if(locks.get(projectId)===work)locks.delete(projectId);}}
function publicServer(server){const {env,headers,url,...safe}=server;let publicUrl=url||'';try{const parsed=new URL(publicUrl);parsed.search='';publicUrl=parsed.href;}catch{}return {...safe,url:publicUrl,envKeys:Object.keys(env||{}),headerKeys:Object.keys(headers||{}),execution:{state:'restricted',reason:'DSH pre-tool enforcement is not verified; discovery does not authorize execution.'}};}
export async function getMcpCatalogue(projectId){const config=await readMcpConfig(projectId);return {version:config.version,servers:config.servers.map(publicServer)};}
export async function saveMcpServer(projectId,input){await change(projectId,config=>{
 if(input.expectedVersion!==undefined&&input.expectedVersion!==config.version)throw fail('MCP configuration changed; reload before saving.',409);
 if(!/^[a-z][a-z0-9-]{0,31}$/.test(input.id||''))throw fail('Server ID must use lowercase letters, numbers and hyphens.');
 const old=config.servers.find(server=>server.id===input.id)||{};
 if(!old.id&&config.servers.length>=20)throw fail('Maximum 20 MCP servers per project.');
 const server={...old,id:input.id,name:String(input.name||input.id).slice(0,120),transport:input.transport||old.transport,enabled:input.enabled??old.enabled??false,command:input.command??old.command??'',args:input.args??old.args??[],url:input.url??old.url??'',env:input.env===undefined?old.env||{}:credentials(input.env),headers:input.headers===undefined?old.headers||{}:credentials(input.headers),roles:list(input.roles??old.roles),tasks:list(input.tasks??old.tasks),tools:list(input.tools??old.tools),capability:input.capability??old.capability??'project.read'};
 if(typeof server.enabled!=='boolean'||!['stdio','streamable-http'].includes(server.transport))throw fail('Invalid transport or enabled state.');
 if(!Array.isArray(server.args)||server.args.length>32||server.args.some(arg=>typeof arg!=='string'||arg.length>4096)||typeof server.command!=='string'||server.command.length>2048)throw fail('Invalid command/arguments.');
 if(server.transport==='stdio'&&!server.command.trim())throw fail('stdio requires an executable command.');
 if(server.transport==='streamable-http'){let url;try{url=new URL(server.url);}catch{throw fail('Invalid MCP URL.');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('MCP URL must be HTTP(S) without embedded credentials.');}
 if(server.roles.some(id=>!getRole(id))||server.tasks.length>32||server.tasks.some(value=>value.length>80)||server.tools.length>100||server.capability!=='project.read')throw fail('Only explicitly bound project.read tools are supported in this release.');
 const connection=value=>JSON.stringify([value.transport,value.command,value.args,value.url,value.env,value.headers]);
 if(connection(server)!==connection(old))server.discovery=null;
 server.updatedAt=new Date().toISOString();config.servers=config.servers.filter(value=>value.id!==server.id).concat(server);
 });return getMcpCatalogue(projectId);}
export async function deleteMcpServer(projectId,id){await change(projectId,config=>{config.servers=config.servers.filter(server=>server.id!==id);});return getMcpCatalogue(projectId);}
export async function withMcpClient(projectId,server,work,{signal}={}){
 const {root}=await rootFile(projectId);const home=path.join(root,'.scienceprism/mcp-runtime',randomUUID());await fs.mkdir(path.join(home,'tmp'),{recursive:true});
 const client=new Client({name:'scienceprism',version:'1.0.0'});
 const transport=server.transport==='stdio'?new StdioClientTransport({command:server.command,args:server.args,cwd:root,env:{PATH:process.env.PATH||'',LANG:process.env.LANG||'en_US.UTF-8',...server.env,HOME:home,TMPDIR:path.join(home,'tmp'),XDG_CONFIG_HOME:home,XDG_CACHE_HOME:home},stderr:'ignore',maxBufferSize:1_000_000}):new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:server.headers},reconnectionOptions:{maxRetries:0}});
 const abort=()=>{void client.close().catch(()=>{});void transport.close().catch(()=>{});};
 const timeout=setTimeout(abort,10_000);signal?.addEventListener('abort',abort,{once:true});
 try{if(signal?.aborted)throw fail('MCP operation cancelled.',499);await client.connect(transport,{timeout:8000,signal});return await work(client);}finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);await client.close().catch(()=>{});await transport.close().catch(()=>{});await fs.rm(home,{recursive:true,force:true});}
}
export async function discoverMcpTools(projectId,id){const config=await readMcpConfig(projectId);const server=config.servers.find(value=>value.id===id);if(!server)throw fail('MCP server not found.',404);if(!server.enabled)throw fail('Disabled MCP server cannot connect.',409);
 let discovery;try{const tools=await withMcpClient(projectId,server,async client=>{const all=[];let cursor;for(let page=0;page<10;page++){const result=await client.listTools(cursor?{cursor}:undefined,{timeout:8000});all.push(...result.tools);cursor=result.nextCursor;if(!cursor)break;}return all.slice(0,100);});discovery={state:'discovered',at:new Date().toISOString(),tools:tools.map(tool=>({id:`${id}/${tool.name}`,name:tool.name,publicName:`mcp__${id}__${tool.name}`,description:String(tool.description||'').slice(0,2000),inputSchema:JSON.stringify(tool.inputSchema).length<=64000?tool.inputSchema:null,readOnlyHint:tool.annotations?.readOnlyHint===true})),limit:100};}catch(error){discovery={state:'failed',at:new Date().toISOString(),tools:[],error:'MCP handshake or tool discovery failed. Check command, URL, credentials and server availability.'};}
 await change(projectId,current=>{const target=current.servers.find(value=>value.id===id);if(!target||target.updatedAt!==server.updatedAt||!target.enabled)throw fail('MCP configuration changed during discovery; retry.',409);target.discovery=discovery;});return getMcpCatalogue(projectId);
}
