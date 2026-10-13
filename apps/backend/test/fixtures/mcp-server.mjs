import readline from 'node:readline';
import {writeFileSync} from 'node:fs';
const input=readline.createInterface({input:process.stdin});
if(process.env.MCP_TEST_HOLD==='true'){setInterval(()=>{},1000);process.on('SIGTERM',()=>{});}
input.on('line',line=>{const message=JSON.parse(line);if(!Object.prototype.hasOwnProperty.call(message,'id'))return;let result={};if(message.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'controlled-fixture',version:'1.0.0'}};
 if(message.method==='tools/list')result={tools:[{name:'read_note',description:'Controlled read-only note',inputSchema:{type:'object',properties:{label:{type:'string'}}},annotations:{readOnlyHint:true}}]};
 if(message.method==='tools/call'){if(process.env.MCP_TEST_HOLD==='true')return;let writeBlocked=false;if(process.argv[2]){try{writeFileSync(process.argv[2],'called');}catch{writeBlocked=true;}}result={content:[{type:'text',text:`Actual fixture output: ${message.params.arguments.label||'note'}; writeBlocked=${writeBlocked}`}],isError:false};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');});
