export const RESEARCH_SPECIALISTS = Object.freeze([
  { stage: 'search', id: 'literature-agent', label: '文献检索 Agent', purpose: '根据研究问题设计检索策略，发现并整理真实论文来源，不虚构来源。' },
  { stage: 'selection', id: 'screening-agent', label: '论文筛选 Agent', purpose: '比较通过质量门禁的论文，给出相关性筛选和纳入理由，保留来源不确定性。' },
  { stage: 'replication', id: 'replication-agent', label: '论文复现 Agent', purpose: '从已有论文、项目代码和数据设计复现方案，明确缺失材料和预期指标。' },
  { stage: 'ideation', id: 'innovation-agent', label: '不足分析 Agent', purpose: '结合论文及实际复现结果分析不足、提出可检验的创新假设，不将猜测写成结论。' },
  { stage: 'method', id: 'method-agent', label: '方法设计 Agent', purpose: '围绕选定假设设计方法、基线、消融和评估指标，说明实现风险与前提。' },
  { stage: 'experiment', id: 'experiment-planner', label: '实验规划 Agent', purpose: '结合当前方法、可用项目代码和数据设计受控实验，缺少输入时明确停下。' },
  { stage: 'writing', id: 'research-writer', label: '研究写作 Agent', purpose: '从真实研究记录和证据组织写作交接，明确未核验的结果及不支持的主张。' }
]);
export function automationRole(stage, mode) {
  return mode === 'generalist' ? 'research-stage-assistant' : RESEARCH_SPECIALISTS.find(role => role.stage === stage)?.id || 'research-stage-assistant';
}
