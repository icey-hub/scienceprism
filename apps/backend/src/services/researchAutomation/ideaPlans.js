import { getResearchWorkflow } from '../researchWorkflow/queries.js';
import { getIdeaPlan } from '../researchWorkflow/ideaPlans.js';
import { generateIdeaPlan } from '../researchWorkflow/ideaPlanGeneration.js';
import { createAutomationStageHarness } from './stageHarness.js';
import { createAutomationStageSearch } from './stageSearch.js';
import { automationRole } from './agents.js';
import { getExperimentRun } from '../experimentRunner/index.js';

/** Plans share the ideation step's actual model and search receipts. */
export async function prepareAutomationIdeaPlans({ projectId, session, policy, runtime, beforeEffect, saveStep }) {
  const stage = 'ideation', step = session.steps.find(item => item.stage === stage);
  const workflow = await getResearchWorkflow(projectId);
  const ideas = workflow.stages.find(item => item.id === stage).data.ideas || [];
  const selected = ideas.filter(idea => idea.selected);
  const candidates = selected.length ? selected : ideas.slice(0, 1);
  const replicationRunId = session.steps.find(item => item.stage === 'replication')?.experimentRunId;
  const replication = replicationRunId ? await getExperimentRun(projectId, replicationRunId) : null;
  const runHarness = createAutomationStageHarness({ projectId, session, stage, step, signal: runtime.signal, beforeEffect, saveStep });
  const search = createAutomationStageSearch({ session, stage, step, signal: runtime.signal, beforeEffect, saveStep });
  const plans = [];
  for (const idea of candidates) {
    await beforeEffect();
    const previous = await getIdeaPlan(projectId, idea.id);
    // A researcher may have saved a plan while the chain was paused. Keep it.
    const result = previous.plan ? previous : await generateIdeaPlan(projectId, idea.id, {
      expectedRevision: 0,
      ...(replication?.status === 'completed' && replication.paperComparison ? { replicationRunId } : {})
    }, { ...runtime, ...runtime.testInput?.hypothesis_plan, role: automationRole(stage, policy.agentMode), search, runHarness,
      context: { automationHandoff: step.handoff }, beforeEffect });
    plans.push({ ideaId: idea.id, revision: result.plan.revision, sourceRunId: result.plan.sourceRunId || null });
    await saveStep({ ideaPlans: [...plans] });
  }
  return getResearchWorkflow(projectId);
}
