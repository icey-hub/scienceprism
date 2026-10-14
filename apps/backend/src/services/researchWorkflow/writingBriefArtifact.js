import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRoot } from '../projectService.js';

export const WRITING_BRIEF_PATH = 'research/writing-brief.md';

function asText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function bullet(value) {
  return `- ${asText(value).replace(/\r?\n/g, ' ')}`;
}
const cell=value=>asText(value).replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
const number=value=>value===null||value===undefined?'未报告':cell(value);

/** Persist a reviewable editor artifact without mutating the manuscript. */
export async function writeWritingBriefArtifact(projectId, brief, { generatedAt = new Date().toISOString(), delegation = null, replicationRun = null, experimentRun = null, validationCampaign = null } = {}) {
  const root = await getProjectRoot(projectId);
  const outputPath = path.join(root, WRITING_BRIEF_PATH);
  const claims = Array.isArray(brief?.claims) ? brief.claims : [];
  const outline = Array.isArray(brief?.outline) ? brief.outline : [];
  const lines = [
    `# ${asText(brief?.title) || 'Writing Brief'}`,
    '',
    `<!-- scienceprism-writing-brief: generatedAt=${generatedAt} -->`,
    '',
    ...(delegation ? [
      '## Review Run Provenance',
      `- Coordinator Run: \`${asText(delegation.parentRunId)}\``,
      ...(delegation.children || []).map((child) => `- ${asText(child.label)}: \`${asText(child.runId)}\` (review opinion, not verified Evidence)`),
      ''
    ] : []),
    ...(validationCampaign ? [
      '## Validation Campaign Provenance',
      `- Campaign: \`${asText(validationCampaign.campaignId)}\` · frozen plan v${validationCampaign.planRevision}`,
      `- Status: ${asText(validationCampaign.status)}; fixed-condition verdict: ${asText(validationCampaign.comparison?.verdict)}`,
      `- Complete-source SHA-256: \`${asText(validationCampaign.sourceSha256)}\``,
      `- Actual Runs: ${validationCampaign.actualExperimentRunIds.map(id=>`\`${id}\``).join(', ') || 'none; reserved IDs are not executions'}`,
      `- Independent evaluation Run: ${validationCampaign.agentEvaluation ? `\`${validationCampaign.agentEvaluation.runId}\`` : 'not selected'}`,
      `- Verification limit: ${asText(validationCampaign.verificationNote)}`,
      '',
      '### 固定条件比较',
      '| 候选 / 对照 | 指标 | 候选均值 | 对照均值 | 平均改善 | 冻结阈值 | 判定 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...(validationCampaign.comparison?.summaries||[]).map(row=>`| ${cell(row.candidateLabel)} / ${cell(row.comparisonLabel)} | ${cell(row.metricName)} | ${number(row.candidateMean)} | ${number(row.comparisonMean)} | ${number(row.meanImprovement)} | ${number(row.threshold)} | ${cell({supported:'固定条件下支持',refuted:'固定条件下反证',insufficient:'证据不足'}[row.verdict]||row.verdict)} |`),
      '',
      ...Object.values(validationCampaign.comparison?.rules||{}).map(bullet),
      '', '### 批次与评价局限',
      ...(validationCampaign.comparison?.limitations||[]).map(bullet),
      ...(validationCampaign.agentEvaluation?.output?.limitations||[]).map(bullet), ''
    ] : []),
    ...[['Replication', replicationRun], ['Experiment', experimentRun]].flatMap(([label, run]) => run ? [
      `## ${label} Run Provenance`,
      `- Run ID: \`${asText(run.id)}\``,
      `- Status: \`${asText(run.status)}\``,
      `- Evidence: \`${asText(run.evidenceId)}\` (${asText(run.evidenceStatus) || 'unknown'})`,
      `- Supports successful finding: ${run.supportsSuccessfulFinding ? 'yes' : 'no'}`,
      `- Provenance: ${asText(run.provenance?.plan?.repository || run.provenance?.plan?.methodId) || 'unrecorded'}; code ${asText(run.codeVersion) || 'unrecorded'}; dataset ${asText(run.dataset?.name || run.dataset?.id) || 'unrecorded'} (${asText(run.dataset?.version) || 'unrecorded'})`,
      `- Code snapshot: \`${asText(run.codeSnapshotHash) || 'unrecorded'}\``,
      ...(run.metrics || []).map((metric) => `- Metric ${asText(metric.name)}: ${metric.value === undefined || metric.value === null ? 'unreported' : asText(metric.value)}${metric.uncertainty === undefined || metric.uncertainty === null ? '' : ` ± ${asText(metric.uncertainty)}`}`),
      ...(run.artifacts || []).map((artifact) => `- Artifact \`${asText(artifact.id)}\`: ${asText(artifact.path) || asText(artifact.name)} (${asText(artifact.evidenceStatus) || 'unknown'} Evidence; SHA-256: ${asText(artifact.sha256) || 'unrecorded'})`),
      `- Verification limit: ${asText(run.verificationNote) || 'Human verification is required before treating findings as successful.'}`,
      ''
    ] : []),
    '## Outline',
    ...(outline.length ? outline.map(bullet) : ['- Add an outline after human review.']),
    '',
    '## Claims And Evidence',
    ...(claims.length
      ? claims.map((claim) => `${bullet(claim.text)}\n  - Claim ID: \`${asText(claim.id)}\`\n  - Evidence IDs: ${claim.evidenceIds?.length ? claim.evidenceIds.map((id) => `\`${id}\``).join(', ') : 'none'}\n  - Confidence: ${claim.confidence ?? 'unverified'}`)
      : ['- No Paper Claims were returned. Any prose remains unverified.']),
    '',
    '## Limitations',
    ...((brief?.limitations || []).length ? brief.limitations.map(bullet) : ['- Add limitations during human review.']),
    '',
    '## Unverified Claims',
    ...((brief?.unsupportedClaims || []).length ? brief.unsupportedClaims.map(bullet) : ['- None recorded by the Harness.']),
    ...(validationCampaign?[
      '', '## 完整来源附录',
      '完整冻结方案、全部试验、失败/缺失/负结果与评价来源保留如下；不改变文稿或确认Evidence。',
      '````json',JSON.stringify(validationCampaign,null,2),'````'
    ]:[]),
    ''
  ];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary=`${outputPath}.${randomUUID()}.tmp`;
  try{await fs.writeFile(temporary,lines.join('\n'),'utf8');await fs.rename(temporary,outputPath);}finally{await fs.rm(temporary,{force:true});}
  return { path: WRITING_BRIEF_PATH, generatedAt };
}
