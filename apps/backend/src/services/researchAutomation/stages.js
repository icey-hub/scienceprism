import { runUiAction, stageData } from '../researchWorkflow/application.js';
import { updateResearchWorkflow } from '../researchWorkflow/commands.js';
import { runResearchStage } from '../researchResearch/index.js';
import { createStageTask } from '../researchWorkflow/stageTask.js';
import { snapshotExperimentCode } from '../experimentRunner/manifest.js';
import { resolveProjectRoot } from '../researchWorkflow/repository.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { automationRole } from './agents.js';
import { createHash } from 'node:crypto';
import { createAutomationStageHarness } from './stageHarness.js';
import { loadPaperSearches, searchProjectPapers } from '../paperSearch.js';
import { datasetService } from '../datasets/index.js';
import { acquireAutomationDataset } from './datasetAcquisition.js';
import { prepareAutomationEnvironment } from './environmentPreparation.js';
import { environmentService } from '../experimentRunner/environments.js';
import { resolveExperimentDataset } from '../experimentRunner/datasetInput.js';
import { allowsAutomatic, readAutomation } from './policy.js';
import { prepareAutomationCode } from './codePreparation.js';
import { codePreparationService } from '../experimentRunner/codePreparations.js';
import { allowsControlledCodePatch } from '../harnessRuntime/dshFileBroker.js';
import { prepareAutomationCodeTrial } from './codeRepair.js';
import { isAutomationExecutionPlanLocked } from './executionPlan.js';

export async function prepareAutomationStage(projectId, workflow, session, policy, runtime, saveStep) {
  const stage = workflow.currentStage, role = automationRole(stage, policy.agentMode);
  const direction = stageData(workflow, 'direction');
  const step = session.steps.find(step => step.stage === stage);
  let searches = [...(step.searches || [])];
  const beforeEffect = runtime.automationCheckpoint || (async () => {});
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const runHarness = createAutomationStageHarness({ projectId, session, stage, step, signal: runtime.signal, beforeEffect, saveStep });
  const runStage = params => runResearchStage({ ...params, workflowStage: stage, context: { ...params.context, automationHandoff: step.handoff }, runHarness });
  const search = async (id, input, options = {}) => {
    await beforeEffect();
    const key = `${session.id}:${stage}:${hash(input)}`;
    const saved = searches.find(item => item.key === key);
    const previous = (await loadPaperSearches(projectId)).sessions.find(item => item.automation?.key === key);
    if (previous) {
      if (previous.automation.sessionId !== session.id || previous.automation.parentRunId !== session.coordinatorRunId) throw new ResearchWorkflowError(409, 'AUTOMATION_SEARCH_OWNER_CHANGED', '检索记录不属于当前交接。');
      return previous;
    }
    if (saved) throw new ResearchWorkflowError(409, 'AUTOMATION_SEARCH_UNRESOLVED', '检索已开始但没有完整回执；请核对已有搜索记录，不会自动重复。');
    searches.push({ key, status: 'prepared' }); await saveStep({ searches });
    const result = await searchProjectPapers(id, input, { ...options, signal: runtime.signal, beforeRequest: () => beforeEffect(), beforePersist: () => beforeEffect(),
      automation: { key, sessionId: session.id, parentRunId: session.coordinatorRunId, stage } });
    searches = searches.map(item => item.key === key ? { ...item, status: 'completed', searchSessionId: result.id } : item);
    await saveStep({ searches }); return result;
  };
  const actionOptions = { signal: runtime.signal, runStage, search, beforeCommit: beforeEffect };
  const body = { expectedVersion: workflow.version, role, llmConfig: runtime.llmConfig, adapter: runtime.adapter,
    idempotencyKey: `${session.id}:${stage}:prepare:${session.attempt || 0}`, ...runtime.testInput?.[stage] };
  const humanInstructions = Object.entries(workflow.humanInstructions || {}).map(([stage, value]) => `${stage}: ${value}`).join('\n');
  const run = async (contract, input) => {
    const result = await runStage({ stage: contract, workflowStage: stage, projectId, input, role, humanInstructions, llmConfig: runtime.llmConfig, adapter: runtime.adapter, ...runtime.testInput?.[contract] });
    if (!result.ok || !result.output) throw new ResearchWorkflowError(409, 'AUTOMATION_MODEL_FAILED', 'Agent输出未通过校验，已保留Run供检查。', result.validation);
    return result;
  };
  const update = data => updateResearchWorkflow(projectId, { actor: 'system', stageId: stage, data, expectedVersion: workflow.version, beforeCommit: beforeEffect, idempotencyKey: `${session.id}:${stage}:prepare:${session.attempt || 0}` });

  if (stage === 'direction') {
    if (!String(direction.researchQuestion || direction.topic || '').trim()) throw new ResearchWorkflowError(409, 'RESEARCH_QUESTION_REQUIRED', '请先填写研究问题。');
    return workflow;
  }
  if (stage === 'search') {
    const next = await runUiAction(projectId, { ...body, action: 'search', direction: { question: direction.researchQuestion || direction.topic }, query: direction.researchQuestion || direction.topic, maxResults: 10 }, 'system', actionOptions);
    const task = stageData(next, stage).task;
    if (!stageData(next, stage).papers?.length || task.validation?.ok === false) throw new ResearchWorkflowError(409, 'AUTOMATION_NO_PAPERS', '检索没有得到可用论文，请检查来源与检索条件。');
    return next;
  }
  if (stage === 'selection') {
    const candidates = (stageData(workflow, 'search').evaluations || []).filter(item => item.decision === 'accept').map(item => item.candidate);
    if (!candidates.length) throw new ResearchWorkflowError(409, 'AUTOMATION_QUALITY_GATE', '论文尚未通过质量门禁，请补充来源信息或调整检索条件。');
    const result = await run('paper_selection', { candidates });
    if (result.output.paperIds.some(id => !candidates.some(paper => String(paper.id) === id))) throw new ResearchWorkflowError(409, 'AUTOMATION_UNKNOWN_PAPER', '筛选Agent引用了候选列表以外的论文。');
    return update({ automaticSelectionProposal: result.output, task: createStageTask({ stage, harness: result, input: { candidates }, output: result.output }) });
  }
  if (stage === 'replication' || stage === 'experiment') {
    const snapshot = await snapshotExperimentCode(await resolveProjectRoot(projectId));
    const files = snapshot.files.map(file => file.path);
    const papers = stageData(workflow, 'selection').selectedPapers || [];
    const saved = stageData(workflow, stage);
    let plan = session.executionPlan || saved.executionPlan;
    let origin = session.executionPlan ? session.executionPlanOrigin || 'legacy' : 'stage';
    let availableDatasets=[],availableEnvironments=[],preparedCode;
    const prepareEnvironment = async () => {
      const recorded=step.environmentPreparations||[];
      if(recorded.length){for(const item of recorded){
        availableEnvironments.push(item.status==='completed'?(await environmentService.verify(projectId,item.environmentId,item.sha256)).environment:
          await prepareAutomationEnvironment({projectId,session,stage,proposal:item.authorization.proposal,sourceRunId:item.authorization.sourceRunId,reason:item.reason,saveStep,beforeEffect,signal:runtime.signal}));
      }}else{
        if(!allowsAutomatic(policy,'environment'))throw new ResearchWorkflowError(409,'AUTOMATION_CONFIRMATION_REQUIRED','环境准备环节等待授权。',{part:'environment'});
        const result=await run('environment_proposal',{papers,savedPlan:saved,availableFiles:files,
          ...(plan ? {executionPlan:plan,entrypoint:plan.execution?.entrypoint} : {}),
          ...(preparedCode ? {preparedCode:{id:preparedCode.preparation.id,files:preparedCode.files.map(file=>({path:file.path,sha256:file.sha256,content:file.content}))}} : {}),
          availableWheels:snapshot.files.filter(file=>file.path.endsWith('.whl')&&file.sha256).map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes})),
          scope:policy.environmentScope,instructions:'Inspect the existing Python entrypoint and dependency declarations using project reads. Propose only existing fixed wheel paths and their supplied SHA256 hashes. An empty packages list means a standard-library-only environment. If dependencies or executable code are missing, list missing materials. The application prepares and verifies the environment; do not claim installation or experiment success.'});
        if(result.output.blockers.length)throw new ResearchWorkflowError(409,'AUTOMATION_ENVIRONMENT_MATERIALS_REQUIRED',`需要补充环境材料：${result.output.blockers.map(item=>item.detail).join('；')}`);
        if(result.output.packages.some(wheel=>!snapshot.files.some(file=>file.path===wheel.path&&file.sha256===wheel.sha256)))throw new ResearchWorkflowError(409,'AUTOMATION_ENVIRONMENT_WHEEL_CHANGED','环境建议没有使用当前项目中已核对的依赖文件。');
        availableEnvironments.push(await prepareAutomationEnvironment({projectId,session,stage,proposal:{packages:result.output.packages},sourceRunId:result.runId,reason:result.output.reason,deferred:result.output.deferred,saveStep,beforeEffect,signal:runtime.signal}));
      }
    };
    if(!plan&&!policy.codeScope&&(policy.environmentScope||step.environmentPreparations?.length)&&files.some(file=>/\.py$/i.test(file)))await prepareEnvironment();
    if(!plan&&policy.datasetScope){
      const recorded=(await datasetService.list(projectId)).datasets.slice(-5);
      availableDatasets=await Promise.all(recorded.map(dataset=>datasetService.get(projectId,dataset.id)));
      const pending=(step.datasetAcquisitions||[]).filter(item=>item.status!=='completed');
      if(pending.length){for(const item of pending)availableDatasets.push(await acquireAutomationDataset({projectId,session,stage,proposal:item.authorization.proposal,sourceRunId:item.authorization.sourceRunId,evidenceQuote:item.evidenceQuote,saveStep,beforeEffect,signal:runtime.signal}));}
      else if(!availableDatasets.length){
        if(!allowsAutomatic(policy,'dataset'))throw new ResearchWorkflowError(409,'AUTOMATION_CONFIRMATION_REQUIRED','数据获取环节等待授权。',{part:'dataset'});
        const discovered=await run('dataset_discovery',{papers,availableFiles:files,allowedSources:policy.datasetScope.allowedHosts,
          instructions:'Find public raw data links in the supplied papers, data availability statements, or existing project notes. Use evidenceQuote to retain the source statement. Missing private data, unavailable links or uncertain sources must be reported. Acquisition is performed by the application; do not claim success.'});
        if(!discovered.output.candidates.length)throw new ResearchWorkflowError(409,'AUTOMATION_DATASET_SOURCE_REQUIRED',`没有可取得的数据来源：${discovered.output.missing.join('；')||'请补充论文的数据声明或公开数据链接。'}`);
        for(const candidate of discovered.output.candidates.slice(0,policy.datasetScope.maxDatasets)){
          if(!papers.some(paper=>String(paper.id)===candidate.paperId))throw new ResearchWorkflowError(409,'AUTOMATION_UNKNOWN_PAPER','数据建议必须引用当前已选论文。');
          const {evidenceQuote,...proposal}=candidate;
          availableDatasets.push(await acquireAutomationDataset({projectId,session,stage,proposal,sourceRunId:discovered.runId,evidenceQuote,saveStep,beforeEffect,signal:runtime.signal}));
        }
      }
    }
    if (!plan) {
      availableDatasets=[...new Map(availableDatasets.map(dataset=>[dataset.id,dataset])).values()];
      const result = await run('execution_proposal', { papers, savedPlan: saved, method: stageData(workflow, 'method'), availableFiles: files,
        ...(policy.codeScope ? {codeScope:policy.codeScope,codeInstruction:'A new source entrypoint within the explicit codeScope is permitted only when the supplied paper, protocol, fixed dataset and evaluation materials define its implementation. The application will delegate implementation to Codex and freeze it before execution. Do not claim the file already exists. A new Python entrypoint may omit environmentId here; its environment is prepared after code verification. Missing scientific materials still require plan:null.'} : {}),
        ...(availableDatasets.length?{availableDatasets:availableDatasets.map(dataset=>({id:dataset.id,sha256:dataset.sha256,byteLength:dataset.byteLength,filename:dataset.filename,source:dataset.source,split:dataset.split,preview:dataset.preview}))}:{}),
        ...(availableEnvironments.length?{availableEnvironments:availableEnvironments.map(environment=>({id:environment.id,sha256:environment.sha256,python:environment.python.version,packages:environment.packages})),environmentInstruction:'A Python plan must select one exact prepared environmentId. Existing private dataset copies and code still need Runner preparation; an environment alone is not reproduction.'}:{}),
        instructions: policy.codeScope ? 'Choose an existing code entrypoint or one new entrypoint within codeScope and a real recorded dataset/version. Use an acquired dataset exact id and sha256 when available. The Runner verifies and copies fixed data into its sandbox. SCIENCEPRISM_EXPERIMENT_INPUT is the absolute path of a JSON file; read that file and use dataset.input.path. Never access private storage. The application prepares missing code and its environment after this proposal. Missing protocol, evaluation or data always requires plan:null and specific missing materials. Acquisition and code preparation are not reproduction. Do not fabricate results.'
          : availableDatasets.length?'Choose existing executable code and an acquired dataset exact id and sha256. The Runner verifies and copies the fixed data into its sandbox; code must read SCIENCEPRISM_EXPERIMENT_INPUT JSON and use dataset.input.path. Never access private storage. Inspect whether the existing entrypoint consumes this input correctly. Missing code, incompatible data reader, protocol or environment requires plan:null with specific missing materials. Acquisition is not reproduction. Do not fabricate results.':'Choose an existing code entrypoint and a real recorded dataset/version. If data or code is missing, return plan:null and list missing materials. Do not fabricate a runnable reproduction.' });
      if (!result.output.plan || result.output.missing.length) throw new ResearchWorkflowError(409, 'AUTOMATION_MATERIALS_REQUIRED', `需要补充复现/实验材料：${result.output.missing.join('；') || '代码入口、数据及版本'}`);
      plan = result.output.plan;
      if(availableEnvironments.length&&plan.execution.adapter==='python'&&(files.includes(plan.execution.entrypoint)||plan.execution.environmentId)&&!availableEnvironments.some(environment=>environment.id===plan.execution.environmentId))throw new ResearchWorkflowError(409,'AUTOMATION_ENVIRONMENT_BINDING_REQUIRED','Python计划需要选择已准备的固定环境版本。');
      if(availableDatasets.length&&!availableDatasets.some(dataset=>dataset.id===plan.dataset&&dataset.sha256===plan.datasetVersion))throw new ResearchWorkflowError(409,'AUTOMATION_DATASET_VERSION_CHANGED','实验建议没有绑定已核对的数据版本。');
      origin = 'model';
    }
    if(/^dataset-[a-f0-9]{64}$/.test(plan.dataset))await resolveExperimentDataset(projectId,{id:plan.dataset,version:plan.datasetVersion});
    if (plan.execution?.codePreparationId) {
      preparedCode = await codePreparationService.verify(projectId, plan.execution.codePreparationId, plan.execution.codePreparationId.slice(17));
    } else if (!files.includes(plan.execution?.entrypoint) && policy.codeScope) {
      if (isAutomationExecutionPlanLocked(session)) throw new ResearchWorkflowError(409,'AUTOMATION_EXECUTION_PLAN_LOCKED','已执行的链路计划不能更换代码版本。');
      if (!allowsAutomatic(policy,'code')) throw new ResearchWorkflowError(409,'AUTOMATION_CONFIRMATION_REQUIRED','代码准备环节等待授权。',{part:'code'});
      if (!allowsControlledCodePatch(plan.execution?.entrypoint,{patchPaths:policy.codeScope.allowedPaths})) throw new ResearchWorkflowError(409,'AUTOMATION_CODE_PATH_DENIED','计划的代码入口不属于已授权的源码范围。');
      preparedCode = await prepareAutomationCode({projectId,session,stage,input:{papers,executionPlan:plan,
        availableFiles:snapshot.files.map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes}))},paths:[plan.execution.entrypoint],runtime,runHarness,saveStep,beforeEffect,signal:runtime.signal});
      plan = {...plan,execution:{...plan.execution,codePreparationId:preparedCode.preparation.id},
        codePaths:[...new Set([...(plan.codePaths||files),...preparedCode.files.map(file=>file.path)])]};
    }
    if (preparedCode) {
      for (const file of preparedCode.files) if (!files.includes(file.path)) files.push(file.path);
    }
    if ((preparedCode||policy.codeScope||policy.environmentScope)&&plan.execution.adapter==='python'&&!plan.execution.environmentId) {
        if (isAutomationExecutionPlanLocked(session)) throw new ResearchWorkflowError(409,'AUTOMATION_EXECUTION_PLAN_LOCKED','已执行的链路计划不能更换环境版本。');
        if (!policy.environmentScope && !step.environmentPreparations?.length) throw new ResearchWorkflowError(409,'AUTOMATION_ENVIRONMENT_SCOPE_REQUIRED','新Python代码需要明确的环境准备范围。');
        if (!availableEnvironments.length) await prepareEnvironment();
        if (availableEnvironments.length!==1) throw new ResearchWorkflowError(409,'AUTOMATION_ENVIRONMENT_BINDING_REQUIRED','新Python代码需要唯一已核验的环境版本。');
        plan={...plan,execution:{...plan.execution,environmentId:availableEnvironments[0].id}};
    }
    if (!files.includes(plan.execution?.entrypoint) || !plan.dataset || !plan.datasetVersion) throw new ResearchWorkflowError(409, 'AUTOMATION_MATERIALS_REQUIRED', '项目内需要可运行的代码入口、真实数据和数据版本。');
    const currentCode = (await readAutomation(projectId)).session?.steps?.find(item => item.stage === stage)?.codePreparations;
    if (preparedCode && currentCode?.some(item => item.preparationId === preparedCode.preparation.id)) {
      if (!allowsAutomatic(policy, 'execution')) throw new ResearchWorkflowError(409, 'AUTOMATION_CONFIRMATION_REQUIRED', '工程试跑等待实验执行授权。', { part: 'execution' });
      plan = await prepareAutomationCodeTrial({ projectId, session, stage, plan, saveStep, beforeEffect, runtime, runHarness, signal: runtime.signal,
        onRun: runtime.automationTrialRun });
    }
    await runtime.automationBindExecutionPlan(plan, origin);
    // The Runner validates paths, resources and snapshots again before dispatch.
    if (stage === 'replication') {
      const result = await run('reproduction_plan', { papers, paperId: papers[0]?.id, executionPlan: plan });
      if (!papers.some(paper => String(paper.id) === result.output.paperId)) throw new ResearchWorkflowError(409, 'AUTOMATION_UNKNOWN_PAPER', '复现计划必须引用已选论文。');
      return update({ executionPlan: plan, replication: { repository: papers[0]?.codeUrl || 'project-workspace', environment: availableEnvironments.length?`Python ${availableEnvironments[0].python.version}; ${availableEnvironments[0].id}`:`${process.platform}; node ${process.version}`, dataset: plan.dataset, datasetVersion: plan.datasetVersion, ...(plan.codePaths?{codePaths:plan.codePaths}:{}), note: result.output.objective, expectedMetrics: result.output.expectedOutputs.join('\n'), aiPlan: result.output }, task: createStageTask({ stage, harness: result, input: { papers, plan }, output: result.output }) });
    }
    const method = stageData(workflow, 'method').method || {};
    const result = await run('experiment_plan', { method, methodId: method.id || method.title, datasetIds: [plan.dataset], baselineIds: method.baselines || [] });
    if (result.output.methodId !== (method.id || method.title) || !result.output.datasetIds.includes(plan.dataset)) throw new ResearchWorkflowError(409, 'AUTOMATION_PLAN_MISMATCH', '实验计划不属于当前方法或数据。');
    return update({ ...plan, methodId: method.id || method.title, seed: String(plan.seed ?? 0), repetitions: result.output.repetitions, budget: result.output.computeBudget || '既有运行器资源上限', successCriteria: result.output.successCriteria, task: createStageTask({ stage, harness: result, input: { method, plan }, output: result.output }) });
  }
  const action = { ideation: 'generate-ideas', method: 'generate-method', writing: 'handoff-writing' }[stage];
  if (!action) throw new ResearchWorkflowError(409, 'AUTOMATION_STAGE_UNSUPPORTED', '该阶段没有执行器。');
  const results = session.steps.filter(step => step.result).map(step => step.result);
  const next = await runUiAction(projectId, { ...body, action, replicationResults: results,
    ...(session.steps.find(step => step.stage === 'replication')?.experimentRunId ? { replicationRunId: session.steps.find(step => step.stage === 'replication').experimentRunId } : {}),
    ...(session.steps.find(step => step.stage === 'experiment')?.experimentRunId ? { experimentRunId: session.steps.find(step => step.stage === 'experiment').experimentRunId } : {}) }, 'system', actionOptions);
  const task = stageData(next, stage).task;
  if (task?.validation?.ok === false || task?.status === 'failed') throw new ResearchWorkflowError(409, 'AUTOMATION_MODEL_FAILED', '当前阶段Agent输出未通过校验。');
  return next;
}
