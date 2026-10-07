import { isResearchStageId, type ResearchStageId } from './researchStages';

const lastStage = new Map<string, ResearchStageId>();
const storageKey = (projectId: string) => `scienceprism-research-stage:${projectId}`;

export function rememberResearchStage(projectId: string, stage: ResearchStageId) {
  lastStage.set(projectId, stage);
  try { window.localStorage.setItem(storageKey(projectId), stage); } catch { /* Navigation works without browser storage. */ }
}

export function researchHref(projectId: string, explicitStage?: string) {
  let stage = explicitStage;
  if (!isResearchStageId(stage)) {
    stage = lastStage.get(projectId);
    if (!stage) {
      try { stage = window.localStorage.getItem(storageKey(projectId)) || undefined; } catch { /* Use the default stage when storage is unavailable. */ }
    }
  }
  return `/editor/${projectId}/research/${isResearchStageId(stage) ? stage : 'direction'}`;
}
