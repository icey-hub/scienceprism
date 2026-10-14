import { getExperimentRun, saveExperimentPaperComparison } from '../experimentRunner/index.js';
import { runResearchStage } from '../researchResearch/index.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';
import { createAutomationStageHarness } from './stageHarness.js';
import { automationRole } from './agents.js';

/** Analysis shares the original stage's calls and resume receipts. It never reruns the experiment. */
export async function analyzeAutomationReplication({ projectId, session, policy, runtime, saveStep, beforeEffect }) {
  const step = session.steps.find(item => item.stage === 'replication');
  if (!step?.experimentRunId || step.paperComparison) return;
  await beforeEffect();
  const run = await getExperimentRun(projectId, step.experimentRunId);
  if (run.paperComparison) {
    await saveStep({ paperComparison: { revision: run.paperComparison.revision, sourceRunId: run.paperComparison.sourceRunId || null } });
    return;
  }
  const paper = run.manifest?.replication?.paper;
  if (!paper) {
    await saveStep({ paperComparison: { status: 'missing-source', message: '原运行未绑定论文，请在复现对比表中明确选择来源。' } });
    return;
  }
  await saveStep({ status: 'analyzing' });
  const runHarness = createAutomationStageHarness({ projectId, session, stage: 'replication', step,
    signal: runtime.signal, beforeEffect, saveStep });
  const input = { paper, run: { id: run.id, status: run.status, metrics: run.metrics, artifacts: run.artifacts,
    dataset: run.manifest.dataset, protocol: run.manifest.protocol, evaluationProtocol: run.manifest.evaluationProtocol,
    successCriteria: run.manifest.successCriteria, error: run.error },
    instructions: 'Read the available paper/protocol material. Report original numeric values only with an excerpt and page/table location. Preserve missing reports and failed/missing results. Cause explanations are hypotheses. Do not run or modify code.' };
  const result = await runResearchStage({ stage: 'replication_analysis', workflowStage: 'replication', projectId,
    input, role: automationRole('replication', policy.agentMode), context: { automationHandoff: step.handoff },
    llmConfig: runtime.llmConfig, adapter: runtime.adapter, ...runtime.testInput?.replication_analysis, runHarness });
  if (!result.ok || !result.output) throw new ResearchWorkflowError(409, 'AUTOMATION_ANALYSIS_FAILED', '论文差异分析未通过校验，原实验结果已保留。', result.validation);
  if (result.output.paperId !== paper.id) throw new ResearchWorkflowError(409, 'AUTOMATION_UNKNOWN_PAPER', '差异分析必须使用原运行绑定的论文。');
  await beforeEffect();
  const comparison = await saveExperimentPaperComparison(projectId, run.id,
    { expectedRevision: 0, paperId: paper.id, rows: result.output.rows }, { actor: 'system', sourceRunId: result.runId });
  await saveStep({ paperComparison: { revision: comparison.revision, sourceRunId: result.runId } });
}
