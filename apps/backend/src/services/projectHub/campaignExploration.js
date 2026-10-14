import { assertCampaignEvaluationSource } from '../validationCampaign/agentEvaluation.js';

/** Projection of saved campaign provenance. Never starts or repairs a Run. */
export function addCampaignExploration({ projectId, campaigns, harnessRuns, experimentRuns, nodes, addNode, addEdge }) {
  const experiments = new Map(experimentRuns.map(run => [run.id, run]));
  const campaignMap = new Map(campaigns.map(campaign => [campaign.id, campaign]));
  const href = id => `/editor/${encodeURIComponent(projectId)}/research/experiment?campaign=${encodeURIComponent(id)}#validation-campaign-results`;
  const source = (id, field) => ({ kind: 'campaign', id, field });
  for (const campaign of campaigns) {
    const id = `campaign:${campaign.id}`, planId = `campaign-plan:${campaign.id}`;
    addNode({ id, kind: 'campaign', title: campaign.plan?.hypothesis?.problem || '创新试验批次', status: campaign.status,
      retained: true, sourceRef: source(campaign.id), href: href(campaign.id), version: campaign.planRevision });
    if (campaign.plan && campaign.planSha256) {
      addNode({ id: planId, kind: 'plan', title: `冻结评价方案 v${campaign.planRevision}`, status: 'frozen', retained: true,
        sourceRef: source(campaign.id, 'plan'), href: href(campaign.id), version: campaign.planSha256 });
      addEdge(planId, id, 'defines', source(campaign.id, 'planSha256'));
    }
    const stage = campaign.researchContext?.sourceStage;
    if (stage && nodes.has(`stage:${stage}`)) addEdge(`stage:${stage}`, id, 'runs', source(campaign.id, 'researchContext.sourceStage'));
    // Reserved trial ids are not executions. Only point to records that exist.
    for (const trial of campaign.trials || []) {
      const run = experiments.get(trial.runId), target = `experiment:${trial.runId}`;
      if (run?.manifest?.campaign?.campaignId === campaign.id && run.manifest.campaign.trialId === trial.id && nodes.has(target)) {
        addEdge(id, target, 'runs', source(campaign.id, `trials.${trial.id}.runId`));
      }
    }
    if (experiments.has(campaign.baseRunId) && nodes.has(`experiment:${campaign.baseRunId}`)) {
      addEdge(`experiment:${campaign.baseRunId}`, id, 'provides', source(campaign.id, 'baseRunId'));
    }
  }
  for (const run of harnessRuns) {
    const saved = run.request?.evaluationSource, campaign = campaignMap.get(saved?.campaignId), target = `harness:${run.id}`;
    if (run.request?.source !== 'campaign-evaluation' || run.task !== 'campaign_evaluation' || !campaign || !nodes.has(target)) continue;
    try { assertCampaignEvaluationSource(run, projectId, campaign.id); }
    catch { continue; } // Keep the task node, but never endorse corrupt provenance.
    addEdge(`campaign:${campaign.id}`, target, 'evaluates', { kind: 'harness', id: run.id, field: 'request.evaluationSource.campaignId' });
    for (const runId of saved.trialRunIds || []) {
      const original = experiments.get(runId);
      if (original?.manifest?.campaign?.campaignId !== campaign.id || !nodes.has(`experiment:${runId}`)) continue;
      addEdge(`experiment:${runId}`, target, 'provides', { kind: 'harness', id: run.id, field: 'request.evaluationSource.trialRunIds' });
    }
  }
}
