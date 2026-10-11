import { readWorkflowFile, resolveProjectRoot } from '../researchWorkflow/repository.js';
import { readHarnessRuns } from '../harnessRuntime/repository.js';
import { readExperimentRuns } from '../experimentRunner/repository.js';
import { readEvidenceLedger } from '../evidenceLedger/repository.js';
import { evidenceVersion, sourceForEvidence } from '../evidenceLedger/schema.js';
import { claimRows, checkClaimEvidence, collectEvidenceReferences } from '../evidenceLedger/index.js';

const taskHref = (projectId, taskId) => `/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
const stageHref = (projectId, stage) => `/editor/${encodeURIComponent(projectId)}/research/${stage === 'ideation' ? 'innovation' : stage}`;
const bounded = (value, fallback, max) => Math.min(max, Math.max(1, Math.floor(Number(value) || fallback)));

// Repository reads only: no interrupted-Run recovery, migration writes or model work.
export async function getProjectExploration(projectId, { lens = 'execution', rootId, limit = 400 } = {}) {
  if (!['execution','evidence'].includes(lens)) { const error = new Error('Invalid graph lens.'); error.statusCode = 400; throw error; }
  const root = await resolveProjectRoot(projectId);
  const [harness, experiments, ledger, workflow] = await Promise.all([
    readHarnessRuns(root, projectId), readExperimentRuns(root, projectId), readEvidenceLedger(root, projectId, { readOnly: true }),
    readWorkflowFile(root, projectId, { readOnly: true }).catch(error => { if (error.code === 'WORKFLOW_NOT_FOUND') return null; throw error; })
  ]);
  const nodes = new Map(), edges = new Map();
  const warnings = [];
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return node.id; };
  const addEdge = (from, to, type, sourceRef) => { const id = `${from}>${type}>${to}:${sourceRef.field || sourceRef.id}`; edges.set(id,{ id,from,to,type,sourceRef }); };
  const source = (kind,id,field) => ({kind,id,field});
  const ensureNode = (id,kind,recordId) => addNode({ id,kind,title:recordId,status:'missing',retained:false,sourceRef:source(kind,recordId),href:null });
  const evidenceId = (id,version) => `evidence:${id}@${version || 'unknown'}`;
  const entryMap = new Map(ledger.entries.map(entry => [entry.id,entry]));
  function evidenceRef(id, version) {
    const entry = entryMap.get(id);
    const currentVersion = entry ? evidenceVersion(entry) : null;
    const target = evidenceId(id,version || currentVersion);
    if (!nodes.has(target)) addNode({ id:target,kind:'evidence',title:entry?.title || id,status:entry && (!version || version === currentVersion) ? entry.verificationStatus : entry ? 'stale-reference' : 'missing',version:version || currentVersion,retained:Boolean(entry && (!version || version === currentVersion)),sourceRef:{kind:'evidence',id,version:version || currentVersion},href:`/project/${encodeURIComponent(projectId)}/evidence`,source:entry && (!version || version === currentVersion) ? sourceForEvidence(entry) : null,summary:entry?.summary || '' });
    return target;
  }
  for (const stage of workflow?.stages || []) addNode({ id:`stage:${stage.id}`,kind:'stage',title:stage.label || stage.id,status:stage.status,version:workflow.version,retained:true,sourceRef:source('stage',stage.id),href:stageHref(projectId,stage.id) });
  if (lens === 'evidence') {
    for (const entry of ledger.entries) evidenceRef(entry.id);
    for (const relation of ledger.relations) addEdge(evidenceRef(relation.fromId), evidenceRef(relation.toId), relation.type, source('relation',relation.id));
    const claims = claimRows(ledger,workflow);
    const matrix = checkClaimEvidence(ledger,claims);
    for (const row of matrix.rows) {
      const claim = claims.find(claim => claim.id === row.id);
      const id = `claim:${row.id}`;
      addNode({id,kind:'claim',title:row.text,status:row.status,retained:true,sourceRef:source('claim',row.id,claim.source),href:`/project/${encodeURIComponent(projectId)}/evidence`});
      for (const target of row.evidenceIds) {
        const citations = (claim.citations || []).filter(citation => citation.evidenceId === target);
        const versions = [...new Set(citations.map(citation => citation.sourceVersion).concat(claim.evidenceVersions?.[target] || []))];
        for (const version of versions.length ? versions : [null]) addEdge(id,evidenceRef(target,version),'references',source('claim',row.id,citations.length ? 'citations.sourceVersion' : 'evidenceIds'));
      }
    }
    for (const stage of workflow?.stages || []) for (const ref of collectEvidenceReferences(stage.data, `stages.${stage.id}.data`)) addEdge(`stage:${stage.id}`,evidenceRef(ref.id),'references',source('stage',stage.id,ref.path));
  } else {
    const runs = [...harness.runs, ...(harness.archivedRuns || [])].slice(0,500);
    for (const run of runs) addNode({id:`harness:${run.id}`,kind:'harness',title:`${run.stage || '项目'} / ${run.task || run.id}`,status:run.status,decision:run.humanDecision?.status || 'unknown',retained:!run.archived,retention:run.archived ? 'summary' : 'full',sourceRef:source('harness',run.id),href:taskHref(projectId,`harness:${run.id}`),adapter:run.adapter,version:run.attempt ?? null});
    for (const run of runs) {
      for (const [field,type] of [['parentRunId','delegates'],['replayOf','replays']]) if (run[field]) {
        const parent=`harness:${run[field]}`; if(!nodes.has(parent)) ensureNode(parent,'harness',run[field]);
        addEdge(parent,`harness:${run.id}`,type,source('harness',run.id,field));
      }
      const calls = (run.events || []).filter(event => ['tool/start','tool/call'].includes(event.type) && event.callId).slice(-20);
      for (const event of calls) {
        const id=`call:${run.id}:${event.attempt ?? 'unknown'}:${event.callId}`;
        const end=[...(run.events || [])].reverse().find(item => item.callId === event.callId && item.attempt === event.attempt && ['tool/end','tool/error','tool/result'].includes(item.type));
        addNode({id,kind:'call',title:event.name || '未记录工具名',status:end?.outcome || 'unknown',retained:true,sourceRef:source('call',run.id,event.id || event.callId),href:taskHref(projectId,`harness:${run.id}`)+'?tab=execution',version:event.attempt ?? null});
        addEdge(`harness:${run.id}`,id,'calls',source('harness',run.id,`events.${event.id || event.callId}`));
      }
    }
    for (const stage of workflow?.stages || []) if (stage.data?.task?.harness?.runId) {
      const id=`harness:${stage.data.task.harness.runId}`;if(!nodes.has(id)) ensureNode(id,'harness',stage.data.task.harness.runId);
      addEdge(`stage:${stage.id}`,id,'runs',source('stage',stage.id,'data.task.harness.runId'));
    }
  }
  for (const run of experiments.runs.slice(0,500)) {
    const id=`experiment:${run.id}`;
    addNode({id,kind:'experiment',title:`${run.phase || 'experiment'} / ${run.id}`,status:run.status,decision:run.approval?.decision || 'unknown',retained:true,sourceRef:source('experiment',run.id),href:taskHref(projectId,`experiment-run:${run.id}`),version:run.manifest?.code?.snapshotHash || null});
    const stage=run.manifest?.researchPlan?.sourceStage || run.manifest?.replication?.sourceStage;
    const stageField = run.manifest?.researchPlan?.sourceStage ? 'manifest.researchPlan.sourceStage' : 'manifest.replication.sourceStage';
    if (stage && nodes.has(`stage:${stage}`)) addEdge(`stage:${stage}`,id,'runs',source('experiment',run.id,stageField));
    if (run.evidence?.runId) addEdge(id,evidenceRef(run.evidence.runId),'reports',source('experiment',run.id,'evidence.runId'));
    for (const artifact of run.artifacts || []) {
      const artifactId=`artifact:${run.id}:${artifact.id}`;
      addNode({id:artifactId,kind:'artifact',title:artifact.name,status:ledger.entries.find(entry => entry.metadata?.runId === run.id && entry.metadata?.artifactId === artifact.id)?.verificationStatus || 'verification-unreported',version:artifact.sha256,retained:true,sourceRef:source('artifact',run.id,artifact.id),href:taskHref(projectId,`experiment-run:${run.id}`)+'?tab=artifacts',source:{path:artifact.path},bytes:artifact.bytes});
      addEdge(id,artifactId,'produces',source('experiment',run.id,`artifacts.${artifact.id}`));
    }
  }
  const totalNodes = nodes.size, totalEdges = edges.size;
  let selected = [...nodes.values()];
  if (rootId) {
    const neighbors = new Set([rootId]);
    for (const edge of edges.values()) if (edge.from === rootId || edge.to === rootId) { neighbors.add(edge.from); neighbors.add(edge.to); }
    selected = selected.filter(node => neighbors.has(node.id));
  }
  selected = selected.slice(0,bounded(limit,400,1000));
  const ids = new Set(selected.map(node => node.id));
  const selectedEdges = [...edges.values()].filter(edge => ids.has(edge.from) && ids.has(edge.to));
  if (selected.length < totalNodes) warnings.push('仅展示选定范围；可按节点邻接或提高上限继续查看。');
  if (selected.some(node => !node.retained)) warnings.push('含归档、陈旧引用或缺失源记录；详情以保留范围为准。');
  return {schemaVersion:1,projectId,lens,nodes:selected,edges:selectedEdges,generatedAt:new Date().toISOString(),warnings,scope:{totalNodes,totalEdges,displayedNodes:selected.length,displayedEdges:selectedEdges.length,nodeLimit:bounded(limit,400,1000),harnessLimit:500,experimentLimit:500,callsPerRun:20,ledgerVersion:ledger.version,workflowVersion:workflow?.version || null}};
}
