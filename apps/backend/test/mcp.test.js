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

test('real Runtime MCP adapter dispatches bound tools, records calls, rejects denied tools before side effects',async()=>{
 const {createHarnessRun,startHarnessRun,getHarnessRun}=await import('../src/services/harnessRuntime/index.js');
 const {assertDshMcpPolicy}=await import('../src/services/mcp/execution.js');
 const root=await project('execution'),marker=path.join(root,'called.txt');await saveMcpServer('execution',{...config,args:[...config.args,marker],tasks:['mcp-check']});await discoverMcpTools('execution','notes');
 async function run(toolName,adapter='mcp'){const created=await createHarnessRun('execution',{adapter,role:'project-agent',task:'mcp-check',capabilities:['project.read'],mcpCall:{serverId:'notes',toolName,arguments:{label:'verified actual transport'}}});await startHarnessRun('execution',created.id);for(let i=0;i<200;i++){const result=await getHarnessRun('execution',created.id);if(['completed','failed','cancelled'].includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Run timed out');}
 let result=await run('unknown_tool');assert.equal(result.status,'failed');await assert.rejects(readFile(marker),error=>error.code==='ENOENT');
 result=await run('read_note');assert.equal(result.status,'completed');assert.equal(await readFile(marker,'utf8'),'called');assert.match(result.reply,/verified actual transport/);assert.equal(result.tokenUsage,null);assert.equal(result.events.find(event=>event.type==='tool/start').name,'mcp__notes__read_note');assert.equal(result.events.find(event=>event.type==='tool/end').capability,'project.read');assert.equal(result.humanDecision.status,'none');
 await saveMcpServer('execution',{...config,args:[...config.args,marker],tasks:['mcp-check'],enabled:false});await writeFile(marker,'unchanged');result=await run('read_note');assert.equal(result.status,'failed');assert.equal(await readFile(marker,'utf8'),'unchanged');
 result=await run('read_note','deepseek');assert.equal(result.status,'failed');assert.equal(result.error.code,'MCP_DSH_RESTRICTED');assert.equal(await readFile(marker,'utf8'),'unchanged');
 assert.throws(()=>assertDshMcpPolicy({mcpToolIds:['notes/read_note']}),error=>error.code==='MCP_DSH_RESTRICTED');
 assert.deepEqual(await readdir(path.join(root,'.scienceprism/mcp-runtime')),[]);
});

test('catalogue counts retained call identities, keeps Skill selection distinct, reports legacy gaps',async()=>{
 const {getToolCatalogue}=await import('../src/services/projectHub/toolCatalogue.js');const root=await project('usage');await mkdir(path.join(root,'.scienceprism'),{recursive:true});await writeFile(path.join(root,'.scienceprism/harness-runs.json'),JSON.stringify({schemaVersion:1,projectId:'usage',archivedRuns:[{id:'old'}],runs:[{id:'r',status:'cancelled',skills:['research-writing'],events:[{type:'tool/start',callId:'c',attempt:0,name:'read_research_skill',arguments:'{"name":"research-writing"}'},{type:'tool/call',callId:'c',attempt:0,name:'read_research_skill',arguments:'{"name":"research-writing"}'},{type:'tool/end',callId:'c',attempt:0,outcome:'success'},{type:'tool/start',callId:'unfinished',attempt:0,name:'read_file'},{type:'tool/start',name:'legacy-unknown'}]}]}));
 const result=await getToolCatalogue('usage');assert.equal(result.tools.find(tool=>tool.name==='read_research_skill').calls,1);assert.equal(result.tools.find(tool=>tool.name==='read_research_skill').success,1);assert.equal(result.tools.find(tool=>tool.name==='read_file').cancelled,1);assert.equal(result.skills.find(skill=>skill.name==='research-writing').selectedRuns,1);assert.equal(result.skills.find(skill=>skill.name==='research-writing').recordedReads,1);assert.equal(result.scope.uncorrelatedEvents,1);assert.equal(result.scope.unknownRetentionRuns,1);assert.equal(result.scope.archivedRuns,1);
});

test('tool catalogue bounds the most recent runs and links them in newest-first order', async () => {
 const { getToolCatalogue } = await import('../src/services/projectHub/toolCatalogue.js');
 const root = await project('recent-usage');
 await mkdir(path.join(root, '.scienceprism'), { recursive: true });
 const runs = Array.from({ length: 101 }, (_, index) => ({
  id: `run-${index}`, status: 'completed', events: [
   { type: 'tool/start', name: index === 100 ? 'old-only-tool' : 'read_file', callId: `call-${index}`, attempt: 0 },
   { type: 'tool/end', callId: `call-${index}`, attempt: 0, outcome: 'success' }
  ]
 }));
 await writeFile(path.join(root, '.scienceprism/harness-runs.json'), JSON.stringify({ schemaVersion: 1, projectId: 'recent-usage', runs }));
 const result = await getToolCatalogue('recent-usage');
 assert.equal(result.tools.some(tool => tool.name === 'old-only-tool'), false);
 const reads = result.tools.find(tool => tool.name === 'read_file');
 assert.equal(reads.calls, 100);
 assert.equal(reads.recent[0].runId, 'run-0');
 assert.equal(result.scope.runs, 100);
});
