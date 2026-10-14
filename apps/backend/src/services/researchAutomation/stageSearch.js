import { createHash } from 'node:crypto';
import { loadPaperSearches, searchProjectPapers } from '../paperSearch.js';
import { ResearchWorkflowError } from '../researchWorkflow/errors.js';

/** Reuse a persisted search within its original stage, including after resume. */
export function createAutomationStageSearch({ session, stage, step, signal, beforeEffect, saveStep }) {
  let searches = [...(step.searches || [])];
  return async (projectId, input, options = {}) => {
    await beforeEffect();
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const key = `${session.id}:${stage}:${hash}`;
    const saved = searches.find(item => item.key === key);
    const previous = (await loadPaperSearches(projectId)).sessions.find(item => item.automation?.key === key);
    if (previous) {
      if (previous.automation.sessionId !== session.id || previous.automation.parentRunId !== session.coordinatorRunId) throw new ResearchWorkflowError(409, 'AUTOMATION_SEARCH_OWNER_CHANGED', '检索记录不属于当前交接。');
      return previous;
    }
    if (saved) throw new ResearchWorkflowError(409, 'AUTOMATION_SEARCH_UNRESOLVED', '检索已开始但没有完整回执；请核对已有搜索记录，不会自动重复。');
    searches.push({ key, status: 'prepared' }); await saveStep({ searches });
    const result = await searchProjectPapers(projectId, input, { ...options, signal, beforeRequest: () => beforeEffect(), beforePersist: () => beforeEffect(),
      automation: { key, sessionId: session.id, parentRunId: session.coordinatorRunId, stage } });
    searches = searches.map(item => item.key === key ? { ...item, status: 'completed', searchSessionId: result.id } : item);
    await saveStep({ searches }); return result;
  };
}
