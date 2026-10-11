import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
const cache=path.resolve('.cache');await mkdir(cache,{recursive:true});const data=await mkdtemp(path.join(cache,'mcp-'));process.env.SCIENCEPRISM_DATA_DIR=data;
const {saveMcpServer,getMcpCatalogue,discoverMcpTools,deleteMcpServer,readMcpConfig}=await import('../src/services/mcp/index.js');
async function project(id){const root=path.join(data,id);await mkdir(root,{recursive:true});await writeFile(path.join(root,'project.json'),JSON.stringify({id}));return root;}
const config={id:'notes',name:'Notes',transport:'stdio',enabled:true,command:process.execPath,args:[path.resolve('apps/backend/test/fixtures/mcp-server.mjs')],env:{API_KEY:'private-fixture-key'},roles:['project-agent'],tasks:['assistant'],tools:['read_note'],capability:'project.read'};

test('actual stdio discovery is scoped, preserves schema and hides credentials, then closes',async()=>{
 const root=await project('one');await project('two');await saveMcpServer('one',config);
 assert.ok(!JSON.stringify(await getMcpCatalogue('one')).includes('private-fixture-key'));
 assert.equal((await readMcpConfig('one')).servers[0].env.API_KEY,'private-fixture-key');
 const result=await discoverMcpTools('one','notes');assert.equal(result.servers[0].discovery.state,'discovered');assert.equal(result.servers[0].discovery.tools[0].id,'notes/read_note');assert.equal(result.servers[0].discovery.tools[0].inputSchema.properties.label.type,'string');
 assert.equal(result.servers[0].execution.state,'restricted');assert.deepEqual((await getMcpCatalogue('two')).servers,[]);
 assert.deepEqual(await readdir(path.join(root,'.scienceprism/mcp-runtime')),[]);
 await saveMcpServer('one',{...config,env:undefined,enabled:false,expectedVersion:result.version});await assert.rejects(discoverMcpTools('one','notes'),error=>error.statusCode===409);
 assert.equal((await readMcpConfig('one')).servers[0].env.API_KEY,'private-fixture-key');
 await assert.rejects(saveMcpServer('one',{...config,expectedVersion:0}),error=>error.statusCode===409);
 await deleteMcpServer('one','notes');assert.deepEqual((await getMcpCatalogue('one')).servers,[]);
});
test('failure and invalid bindings never become discovered/executable',async()=>{
 await project('bad');await saveMcpServer('bad',{...config,command:'/does-not-exist'});const result=await discoverMcpTools('bad','notes');assert.equal(result.servers[0].discovery.state,'failed');assert.deepEqual(result.servers[0].discovery.tools,[]);
 await assert.rejects(saveMcpServer('bad',{...config,roles:['unknown-role']}),error=>error.statusCode===400);
 await assert.rejects(saveMcpServer('bad',{...config,capability:'experiment.execute'}),error=>error.statusCode===400);
});

test('actual Streamable HTTP discovery uses the same bounded catalogue contract',async()=>{
 const {createServer}=await import('node:http');
 const server=createServer(async(req,res)=>{if(req.method!=='POST'){res.writeHead(405).end();return;}let body='';for await(const part of req)body+=part;const message=JSON.parse(body);if(message.id===undefined){res.writeHead(202).end();return;}const result=message.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'http-fixture',version:'1'}}:{tools:[{name:'http_read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await project('http');await saveMcpServer('http',{...config,transport:'streamable-http',url:`http://127.0.0.1:${server.address().port}/mcp`,headers:{Authorization:'Bearer private-http-key'}});const result=await discoverMcpTools('http','notes');assert.equal(result.servers[0].discovery.state,'discovered');assert.equal(result.servers[0].discovery.tools[0].name,'http_read');assert.ok(!JSON.stringify(result).includes('private-http-key'));}finally{await new Promise(resolve=>server.close(resolve));}
});

test('MCP HTTP routes preserve project scope, command errors and masked DTOs',async()=>{
 const {default:Fastify}=await import('fastify');const {registerMcpRoutes}=await import('../src/routes/mcp.js');const app=Fastify();registerMcpRoutes(app);try{await project('routes');let response=await app.inject({method:'PUT',url:'/api/projects/routes/mcp/notes',payload:config});assert.equal(response.statusCode,200);assert.ok(!response.body.includes('private-fixture-key'));response=await app.inject({method:'POST',url:'/api/projects/routes/mcp/notes/discover'});assert.equal(response.json().servers[0].discovery.state,'discovered');response=await app.inject({method:'PUT',url:'/api/projects/routes/mcp/notes',payload:{...config,expectedVersion:0}});assert.equal(response.statusCode,409);assert.equal((await app.inject({method:'GET',url:'/api/projects/missing/mcp'})).statusCode,404);}finally{await app.close();}
});
