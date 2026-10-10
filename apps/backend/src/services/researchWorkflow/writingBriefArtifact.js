import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../projectService.js';

export const WRITING_BRIEF_PATH = 'research/writing-brief.md';

function asText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function bullet(value) {
  return `- ${asText(value).replace(/\r?\n/g, ' ')}`;
}

/** Persist a reviewable editor artifact without mutating the manuscript. */
export async function writeWritingBriefArtifact(projectId, brief, { generatedAt = new Date().toISOString(), delegation = null, replicationRun = null, experimentRun = null } = {}) {
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
    ''
  ];
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  return { path: WRITING_BRIEF_PATH, generatedAt };
}
