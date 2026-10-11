import { resolveHarnessProjectRoot, readHarnessRuns } from '../harnessRuntime/repository.js';
import { capabilityForToolName } from '../harnessRuntime/capabilities.js';
import { listAssistantSkills } from '../assistantService.js';
import { getMcpCatalogue } from '../mcp/index.js';
const BUILT_INS=['read_file','list_files','propose_patch','apply_patch','get_compile_log','arxiv_search','arxiv_bibtex','read_research_skill'];
export async function getToolCatalogue(projectId){
 const root=await resolveHarnessProjectRoot(projectId);
 const [history,skills,mcp]=await Promise.all([readHarnessRuns(root,projectId),listAssistantSkills(projectId),getMcpCatalogue(projectId)]);
 const runs=history.runs.slice(0,100),entries=new Map(BUILT_INS.map(name=>[name,{id:name,name,source:'legacy',capability:capabilityForToolName(name),calls:0,success:0,error:0,incomplete:0,cancelled:0,unknown:0,recent:[]}]));
 for(const server of mcp.servers)for(const tool of server.discovery?.tools||[])entries.set(tool.publicName,{id:tool.publicName,name:tool.publicName,source:'mcp-discovery',capability:server.capability,serverId:server.id,enabled:server.enabled,bound:server.tools.includes(tool.name),dshRestricted:true,calls:0,success:0,error:0,incomplete:0,cancelled:0,unknown:0,recent:[]});
 const skillReads=new Map();let uncorrelated=0,dropped=0,unknownRetention=0;
 for(const run of runs){dropped+=run.eventRetention?.dropped||0;if(!run.eventRetention||run.eventRetention.priorRetentionUnknown)unknownRetention++;
 const calls=new Map();for(const event of run.events||[]){if(!event.type?.startsWith('tool/'))continue;if(!event.callId){uncorrelated++;continue;}const key=`${event.attempt??'unknown'}:${event.callId}`,pair=calls.get(key)||{};if(['tool/start','tool/call'].includes(event.type))pair.start=event;else if(['tool/end','tool/error','tool/result'].includes(event.type))pair.end=event;calls.set(key,pair);}
 for(const [id,pair] of calls){const name=pair.start?.name||pair.end?.name||'unknown-tool';if(!entries.has(name))entries.set(name,{id:name,name,source:'recorded-event',capability:pair.start?.capability||pair.end?.capability||null,calls:0,success:0,error:0,incomplete:0,cancelled:0,unknown:0,recent:[]});const entry=entries.get(name);const outcome=pair.end?.outcome||(!pair.end?(run.status==='cancelled'?'cancelled':'incomplete'):'unknown');entry.calls++;entry[outcome]++;if(entry.recent.length<10)entry.recent.push({runId:run.id,callId:id,outcome,at:pair.end?.at||pair.start?.at||null});
 if(name==='read_research_skill'&&outcome==='success'&&pair.start?.arguments){try{const args=JSON.parse(pair.start.arguments);if(typeof args.name==='string')skillReads.set(args.name,(skillReads.get(args.name)||0)+1);}catch{}}
 }
 }
 return {tools:[...entries.values()],skills:skills.skills.map(skill=>({...skill,selectedRuns:runs.filter(run=>run.skills?.includes(skill.name)||run.request?.researchSkills?.includes(skill.name)).length,recordedReads:skillReads.get(skill.name)||0})),scope:{runLimit:100,runs:runs.length,archivedRuns:history.archivedRuns?.length||0,uncorrelatedEvents:uncorrelated,droppedEvents:dropped,unknownRetentionRuns:unknownRetention},note:'Counts include retained call IDs only. Discovery, selection and successful document reading are separate observations.'};
}
