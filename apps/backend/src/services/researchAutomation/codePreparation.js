import path from 'node:path';
import { codePreparationService } from '../experimentRunner/codePreparations.js';
import { getHarnessRun } from '../harnessRuntime/index.js';
import { contentHash } from '../harnessRuntime/fileVersions.js';
import { allowsControlledCodePatch } from '../harnessRuntime/dshFileBroker.js';
import { readAutomation } from './policy.js';
import { createCodeAuthorization, assertCodeAuthorization } from './codeAuthorization.js';
import { sourceHash } from './handoff.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

const TASK = 'research:code-preparation';
const fail = (code, message) => { throw new ResearchWorkflowError(409, code, message); };
const cancelled = signal => { if (signal?.aborted) fail('AUTOMATION_CODE_CANCELLED', '研究代码准备已停止。'); };

/** Persists a stage grant before its one DSH→Codex producer, then freezes the
 * genuine completed handoff through the existing code preparation domain. */
export async function prepareAutomationCode({ projectId, session, stage, input, paths, repairOf = null, runtime = {}, runHarness, saveStep, beforeEffect, signal,
  service = codePreparationService, readState = () => readAutomation(projectId), readRun = id => getHarnessRun(projectId, id) }) {
  if (typeof runHarness !== 'function' || typeof saveStep !== 'function' || typeof beforeEffect !== 'function'
    || !input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(paths) || !paths.length || paths.length > 20
    || paths.some(relative => typeof relative !== 'string' || path.posix.normalize(relative) !== relative || relative.split('/').some(part => !part || part.startsWith('.')))
    || new Set(paths).size !== paths.length) fail('AUTOMATION_CODE_CONTEXT_REQUIRED', '代码准备需要固定材料、源码路径和当前阶段上下文。');
  let materials = { ...structuredClone(input), codePreparationVersion: 2 }, inputSha256 = sourceHash(materials);
  const task = repairOf ? 'research:code-repair' : TASK;
  if (repairOf && (repairOf.repairIndex !== 1 || repairOf.trialRunId !== input.engineeringRepair?.failure?.runId
    || repairOf.codePreparationId !== input.engineeringRepair?.failure?.codePreparationId)) {
    fail('AUTOMATION_CODE_REPAIR_INVALID', '修复必须关联实际失败的原试跑与代码版本。');
  }
  const selectedPaths = [...paths].sort();
  await beforeEffect(); cancelled(signal);
  const initial = await readState(), step = initial.session?.steps?.find(item => item.stage === stage);
  if (initial.session?.id !== session.id || initial.session?.coordinatorRunId !== session.coordinatorRunId || initial.session.currentStage !== stage || !step?.handoff) {
    fail('AUTOMATION_CODE_OWNER_CHANGED', '代码准备不属于当前研究会话和阶段。');
  }
  // Already published or recoverable legacy work keeps its exact request.
  // A failed old producer is retained; the updated profile is a new input grant.
  const legacy = (step.codePreparations || []).find(item => item.authorization?.inputSha256 === sourceHash(input)
    && (item.preparationId || item.producerRunId && !['failed','cancelled'].includes(item.status)));
  if (legacy) { materials = structuredClone(input); inputSha256 = sourceHash(materials); }
  let entry = (step.codePreparations || []).find(item => item.authorization?.inputSha256 === inputSha256);
  if (repairOf && (step.codePreparations || []).some(item => item.repairOf && item !== entry)) {
    fail('AUTOMATION_CODE_REPAIR_LIMIT', '本阶段已使用一次自动修复，请检查保留的失败记录。');
  }
  if (entry && sourceHash(entry.repairOf || null) !== sourceHash(repairOf)) fail('AUTOMATION_CODE_REPAIR_INVALID', '原修复关联已改变。');
  if (entry && (sourceHash(entry.paths) !== sourceHash(selectedPaths) || sourceHash(entry.input) !== inputSha256)) fail('AUTOMATION_CODE_INPUT_CHANGED', '已有代码授权的材料或所选路径发生变化。');
  const authorization = structuredClone(entry?.authorization || createCodeAuthorization({ projectId, session: initial.session, stage,
    policyVersion: initial.version, policy: initial.policy, inputSha256 }));
  const scope = assertCodeAuthorization(authorization, { projectId, session: initial.session, stage, inputSha256, policyVersion: initial.version, policy: initial.policy });
  if (selectedPaths.some(relative => !allowsControlledCodePatch(relative, { patchPaths: scope.allowedPaths }))) fail('AUTOMATION_CODE_PATH_DENIED', '所选源码路径超出原代码授权范围。');
  const handoff = structuredClone(step.handoff), grantHash = sourceHash(authorization);
  if (!entry) {
    if ((step.codePreparations?.length || 0) >= scope.maxVersions) fail('AUTOMATION_CODE_LIMIT', '本研究阶段已达到代码版本数量预算。');
    entry = { authorization, input: materials, paths: selectedPaths, status: 'prepared', attempt: initial.session.attempt || 0,
      ...(repairOf ? { repairOf: structuredClone(repairOf) } : {}),
      producerRunId: null, preparationId: null, sha256: null };
    await beforeEffect(); cancelled(signal);
    await saveStep({ codePreparations: [...(step.codePreparations || []), entry] });
  }
  const request = { projectId, stage, kind: 'research-stage', task, role: 'experiment-code-producer', adapter: 'deepseek',
    capabilities: ['project.read', 'patch.propose'], fallback: false, llmConfig: runtime.llmConfig,
    limits: { maxTokens: scope.maxTokens, timeoutMs: scope.timeoutMs, retryLimit: 0, maxConcurrent: 1 }, input: materials,
    context: { automationHandoff: handoff, codeAuthorization: authorization },
    prompt: [
      'Prepare source code for the supplied research materials by delegating the coding work to the controlled Codex worker.',
      ...(input.validationDesign ? ['The frozen validationDesign specifies every candidate, baseline and ablation and all repeated seeds. Implement their actual parameter-controlled algorithms in the SAME entrypoint, using the fixed idea plan and implementationNotes. Read each run\'s parameters and seed from SCIENCEPRISM_EXPERIMENT_INPUT. Preserve the supplied split, data version, metrics and thresholds; never hardcode predicted metric values or silently use one algorithm for differently labelled groups. If a condition is not scientifically implementable from the supplied material, report the missing requirement rather than pretending to implement it. Forward the complete validationDesign to the Codex worker. Read only relevant source/protocol paths present in availableFiles; do not guess data files or look for result files that have not been generated. The Runner provides the fixed dataset input at execution time.'] : []),
      ...(repairOf ? ['This is the single permitted engineering repair. Diagnose the retained actual stderr/stdout and previous frozen source in engineeringRepair. Change only code needed to resolve that runtime error. The failed source is an overlay, not applied to the project: propose against the ORIGINAL project baseVersion. Never change data, protocol, seed, expected results, metrics, thresholds or outputs to make the check pass. Preserve negative scientific findings.'] : []),
      ...(legacy ? [] : [`Delegate exactly once with research_delegate_codex, maxTokens ${Math.max(128, Math.floor(scope.maxTokens * 0.8))} and timeoutMs ${Math.max(100, Math.floor(scope.timeoutMs * 0.9))}. These limits include input and output tokens. Do not choose a smaller arbitrary budget. If that child fails, retain the failure and stop; never claim a proposal exists.`]),
      `Only propose these source files: ${selectedPaths.join(', ')}. Read existing protocol and input files through project_read_file.`,
      'Do not edit protocols, datasets, the manuscript or unrelated files. Do not run commands or experiments, install packages, or claim reproduction or scientific success.',
      'The application later runs the frozen code in an isolated Experiment Runner. SCIENCEPRISM_EXPERIMENT_INPUT is an absolute path to a JSON file: open and parse that file, never parse the environment variable itself as JSON. Use its dataset.input.path within the runner workspace.',
      'A missing new source file returns exists:false; propose it using expectedSha256:null. Preserve the fixed protocol, split, seed, expected outputs and artifact declarations. Report missing materials honestly.',
      `Fixed materials:\n${JSON.stringify(materials, null, 2)}`
    ].join('\n\n') };

  const guard = async ({ producerRequired = false } = {}) => {
    await beforeEffect(); cancelled(signal);
    const current = await readState(), currentStep = current.session?.steps?.find(item => item.stage === stage);
    assertCodeAuthorization(authorization, { projectId, session: current.session, stage, inputSha256, policyVersion: current.version, policy: current.policy });
    const bound = currentStep?.codePreparations?.find(item => sourceHash(item.authorization) === grantHash);
    if (current.session.currentStage !== stage || sourceHash(currentStep?.handoff) !== sourceHash(handoff) || !bound
      || sourceHash(bound.paths) !== sourceHash(selectedPaths) || sourceHash(bound.input) !== inputSha256
      || sourceHash(bound.repairOf || null) !== sourceHash(repairOf)
      || (currentStep?.codePreparations?.length || 0) > scope.maxVersions) {
      fail('AUTOMATION_CODE_AUTHORIZATION_CHANGED', '已保存的代码授权、材料或阶段交接发生变化。');
    }
    if (entry.producerRunId && bound.producerRunId !== entry.producerRunId || producerRequired && !bound.producerRunId) fail('AUTOMATION_CODE_PRODUCER_CHANGED', '原代码生产任务身份发生变化。');
    if (bound.producerRunId && !currentStep.calls?.some(call => call.runId === bound.producerRunId && call.task === task)) fail('AUTOMATION_CODE_PRODUCER_CHANGED', '阶段没有保存原代码生产任务调用。');
    return { current, currentStep, bound };
  };
  const persist = async patch => {
    const { currentStep, bound } = await guard(); entry = { ...bound, ...patch };
    await saveStep({ codePreparations: currentStep.codePreparations.map(item => sourceHash(item.authorization) === grantHash ? entry : item) });
  };
  const producer = async id => {
    const { currentStep } = await guard(), run = await readRun(id);
    if (run?.id !== id || run.projectId !== projectId || run.parentRunId !== session.coordinatorRunId || run.stage !== stage
      || run.task !== task || run.role !== request.role || run.adapter !== 'deepseek' || run.kind !== 'research-stage'
      || run.automationSessionId !== undefined && run.automationSessionId !== session.id || run.cleanup?.modelSlotRetained
      || run.error?.code === 'HARNESS_INTERRUPTED' || run.retainedWorkspace && run.status !== 'completed' && run.recovery?.status !== 'ready'
      || !currentStep.calls?.some(call => call.runId === id && call.task === task)
      || sourceHash(run.request?.input) !== inputSha256 || sourceHash(run.request?.context?.codeAuthorization) !== grantHash
      || sourceHash(run.request?.context?.automationHandoff) !== sourceHash(handoff) || run.request?.prompt !== request.prompt
      || run.request?.role !== request.role || run.request?.task !== task || run.request?.fallback !== false
      || sourceHash(run.request?.limits) !== sourceHash(request.limits) || sourceHash(run.request?.capabilities) !== sourceHash(request.capabilities)) {
      fail('AUTOMATION_CODE_PRODUCER_CHANGED', '代码来源任务、授权或真实调用归属已改变。');
    }
    return run;
  };
  const verify = async (id, sha256) => {
    const result = await service.verify(projectId, id, sha256), run = await producer(entry.producerRunId), preparation = result?.preparation;
    if (run.status !== 'completed' || preparation?.id !== id || preparation.sha256 !== sha256 || preparation.projectId !== projectId
      || preparation.source?.runId !== run.id || !Array.isArray(preparation.files) || !Array.isArray(result.files)
      || sourceHash(preparation.files.map(file => file.path).sort()) !== sourceHash(selectedPaths)
      || sourceHash(result.files.map(file => file.path).sort()) !== sourceHash(selectedPaths)) fail('AUTOMATION_CODE_VERSION_CHANGED', '已验证代码没有保留原生产任务和所选源码路径。');
    for (const file of result.files) {
      const patches = (run.patches || []).filter(patch => patch.path === file.path), metadata = preparation.files.find(item => item.path === file.path);
      if (patches.length !== 1 || patches[0].deleted || typeof file.content !== 'string' || patches[0].content !== file.content
        || file.sha256 !== contentHash(file.content) || file.bytes !== Buffer.byteLength(file.content) || !file.baseVersion
        || sourceHash(file.baseVersion) !== sourceHash(patches[0].baseVersion)
        || sourceHash(metadata) !== sourceHash({ path: file.path, sha256: file.sha256, bytes: file.bytes, baseVersion: file.baseVersion })) {
        fail('AUTOMATION_CODE_VERSION_CHANGED', '已验证代码文件与原任务最终提案不符。');
      }
    }
    return result;
  };
  try {
    await guard();
    if (entry.preparationId) {
      if ((await producer(entry.producerRunId)).status !== 'completed') fail('AUTOMATION_CODE_RUN_UNRESOLVED', '已准备代码的原来源任务不再完成。');
      if (!/^code-preparation-[a-f0-9]{64}$/.test(entry.preparationId) || entry.sha256 !== entry.preparationId.slice(17)) fail('AUTOMATION_CODE_VERSION_CHANGED', '已准备代码的固定摘要发生变化。');
      const verified = await verify(entry.preparationId, entry.sha256);
      await guard({ producerRequired: true });
      if (entry.status !== 'completed') await persist({ status: 'completed', error: null });
      return verified;
    }
    if (entry.producerRunId) {
      const old = await producer(entry.producerRunId);
      if (old.status !== 'completed' && old.status !== 'created' && !(old.status === 'paused' && old.recovery?.status === 'ready')) {
        fail('AUTOMATION_CODE_RUN_UNRESOLVED', '原代码任务未完成或仍需对账，请恢复原任务；不会自动新派。');
      }
    }
    let run;
    if (entry.producerRunId && (await producer(entry.producerRunId)).status === 'completed') run = await producer(entry.producerRunId);
    else {
      await guard();
      const result = await runHarness(request, { requireExisting: !entry.producerRunId && ['failed', 'cancelled'].includes(entry.status), onPrepared: async prepared => {
        if (!prepared?.id || entry.producerRunId && entry.producerRunId !== prepared.id) fail('AUTOMATION_CODE_PRODUCER_CHANGED', '代码授权不能更换原生产任务。');
        const actual = await producer(prepared.id);
        if (!['created', 'completed', 'paused'].includes(actual.status)) fail('AUTOMATION_CODE_RUN_UNRESOLVED', '代码任务没有可安全开始或恢复的持久状态。');
        await persist({ producerRunId: actual.id, status: 'producing' });
        await guard({ producerRequired: true });
      } });
      if (!entry.producerRunId || result?.runId !== entry.producerRunId) fail('AUTOMATION_CODE_PRODUCER_CHANGED', '代码执行没有保留原任务的持久身份。');
      if (!result.ok && result.error) throw new ResearchWorkflowError(409, 'AUTOMATION_CODE_PRODUCER_FAILED',
        `代码准备失败：${result.error.code || 'HARNESS_FAILED'} — ${result.error.message || '请查看原任务记录。'}`,
        { sourceRunId: entry.producerRunId, sourceCode: result.error.code || 'HARNESS_FAILED' });
      run = await producer(entry.producerRunId);
    }
    if (run.status !== 'completed') fail('AUTOMATION_CODE_RUN_UNRESOLVED', '原代码任务未完成，不能准备实验版本。');
    await guard({ producerRequired: true });
    const created = await service.create(projectId, { sourceRunId: run.id, paths: selectedPaths });
    const preparation = created.preparation;
    if (preparation?.source?.runId !== run.id || preparation.projectId !== projectId || !/^code-preparation-[a-f0-9]{64}$/.test(preparation.id)
      || preparation.sha256 !== preparation.id.slice(17)) fail('AUTOMATION_CODE_VERSION_CHANGED', '准备的代码没有绑定原任务和固定摘要。');
    await persist({ preparationId: preparation.id, sha256: preparation.sha256, status: 'verifying' });
    await guard({ producerRequired: true });
    const verified = await verify(preparation.id, preparation.id.slice(17));
    await guard({ producerRequired: true });
    await persist({ status: 'completed', cached: created.cached === true, error: null });
    return verified;
  } catch (error) {
    // Retain the original Run/version. Revoked or lost ownership cannot write a
    // new success/failure record; the coordinator retains the terminal error.
    try { await persist({ status: signal?.aborted ? 'cancelled' : 'failed', error: { code: error.code || 'AUTOMATION_CODE_FAILED', message: '代码准备未完成，请核对原任务与固定来源。' } }); } catch {}
    throw error;
  }
}
