import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { HarnessResearchStageId } from '../../researchStageIds';
import { getAssistantSkills, previewAssistantSkill, getResearchWorkflowSkills, getResearchWorkflow, updateResearchWorkflowSkillBindings, listProjects, type AssistantSkill, type ResearchWorkflowState } from '../../api/client';
import { workflowSession } from '../../api/workflowAdapter';
import { getSkillInstallations, type SkillInstallation } from '../../api/skillDiscoveryAdapter';
import { readerError } from '../../api/paperReaderAdapter';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { SkillDiscoveryPanel } from '../skills/SkillDiscoveryPanel';
import { SkillLifecyclePanel } from '../skills/SkillLifecyclePanel';
import './ConfigurationPages.css';

const stages: Record<HarnessResearchStageId, string> = { direction: '方向', search: '检索', selection: '筛选', replication: '复现', ideation: '创新', method: '方法', experiment: '实验', writing: '写作' };
const canBind = (skill: AssistantSkill, stage: HarnessResearchStageId) => skill.available && (!skill.stages.length || skill.stages.includes(stage));
// Effective bindings omit missing Skills for execution. The editor must retain
// explicit saved choices (including empty lists) so users can inspect/remove them.
const editableBindings = (workflow: ResearchWorkflowState | undefined, effective: Partial<Record<HarnessResearchStageId, string[]>> = {}) => ({ ...effective, ...workflow?.skillBindings });
const missingWorkflow = (error: unknown) => {
  try { return JSON.parse(error instanceof Error ? error.message : '').error?.code === 'WORKFLOW_NOT_FOUND'; }
  catch { return false; }
};
export default function SkillsPage() {
  const { projectId = '' } = useParams();
  return <Skills key={projectId} projectId={projectId} />;
}
function Skills({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams(); const selected = params.get('skill');
  const [skills, setSkills] = useState<AssistantSkill[]>([]);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [name, setName] = useState(projectId); const [body, setBody] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [bindings, setBindings] = useState<Partial<Record<HarnessResearchStageId, string[]>>>({});
  const [version, setVersion] = useState<number>();
  const [uninitialized, setUninitialized] = useState(false);
  const [stage, setStage] = useState<HarnessResearchStageId>('writing'); const [note, setNote] = useState('');
  const loadCatalog = async () => {
    // Complete a pending installation recovery before reading the catalog.
    // Refreshing package state must not replace unsaved stage bindings.
    const installed = await getSkillInstallations(projectId);
    const catalog = await getAssistantSkills(projectId);
    setSkills(catalog.skills); setInstallations(installed.installations);
  };
  const load = async () => {
    setError('');
    const [, state] = await Promise.all([loadCatalog(), (async () => {
      try { const workflow = await getResearchWorkflow(projectId); return { workflow, research: await getResearchWorkflowSkills(projectId) }; }
      catch (cause) { if (missingWorkflow(cause)) return null; throw cause; }
    })()]);
    setUninitialized(state === null); setBindings(editableBindings(state?.workflow.workflow, state?.research.bindings)); setVersion(state?.workflow.workflow.version);
  };
  useEffect(() => {
    void load().catch(cause => setError(readerError(cause)));
    void listProjects().then(result => setName(result.projects.find(p => p.id === projectId)?.name || projectId)).catch(() => {});
  }, [projectId]);
  useEffect(() => {
    let active = true; setBody('');
    if (selected && skills.some(item => item.name === selected && item.available)) void previewAssistantSkill(projectId, selected).then(result => {
      if (active) { setBody(result.content); setError(''); }
    }).catch(cause => { if (active) setError(readerError(cause)); });
    return () => { active = false; };
  }, [projectId, selected, skills]);
  const skill = skills.find(item => item.name === selected);
  const installation = installations.find(item => item.name === selected);
  const toggle = (name: string, checked: boolean) => setBindings(old => ({ ...old, [stage]: checked ? [...new Set([...(old[stage] || []), name])] : (old[stage] || []).filter(value => value !== name) }));
  const save = async () => {
    setBusy(true); setError('');
    try {
      const expectedVersion = uninitialized ? (await workflowSession.initialize<{ workflow: ResearchWorkflowState }>(projectId)).workflow.version : version;
      setUninitialized(false); setVersion(expectedVersion);
      const result = await updateResearchWorkflowSkillBindings(projectId, bindings, '独立 Skill 页保存阶段绑定', { expectedVersion });
      setBindings(editableBindings(result.workflow, result.bindings)); setVersion(result.workflow.version); setNote('绑定已保存；新 Run 读取此配置。');
    } catch (cause) { setError(readerError(cause)); } finally { setBusy(false); }
  };
  return <ProjectWorkspaceFrame projectId={projectId} projectName={name} active="skills" title="Skills">
    <SkillDiscoveryPanel projectId={projectId} installations={installations} installedNames={skills.map(item => item.name)} onInstalled={loadCatalog} />
    <h2>可用的 Skills</h2><p className="config-note">包括项目安装和内置项。选择后查看当前生效的来源、正文和阶段绑定。</p>
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
    <div className="config-split"><div className="config-list">{skills.map(item => <button key={item.name} aria-pressed={selected === item.name} onClick={() => setParams({ skill: item.name })}>
      <strong>{item.name}</strong><span>{item.description || item.reason}</span><small>{item.source === 'project' ? '项目 Skill' : '内置 Skill'} {item.shadows ? '· 覆盖内置' : ''} · {item.available ? '可读取' : item.reason}</small>
    </button>)}</div><section className="config-detail">{skill ? <><h2>{skill.name}</h2><p>{skill.relativePath}</p>
      <p>声明阶段：{skill.stages.map(stage => stages[stage as HarnessResearchStageId] || stage).join('、') || '未限定，可在下方显式绑定'}</p>
      {installation && <div className="skill-installation-record"><strong>{installation.integrity === 'verified' ? '安装文件与固定版本一致' : installation.integrity === 'changed' ? '安装后有本地修改' : '来源完整性待核对'}</strong>
        {installation.source && <p><a href={`https://github.com/${installation.source.repository}/tree/${installation.source.commit}/${installation.source.path}`} target="_blank" rel="noreferrer">{installation.source.repository}</a> · <code>{installation.source.commit.slice(0, 12)}</code></p>}
        <p>{installation.fileCount ?? '未知'} 个文件 · 安装不会自动执行脚本或取得额外权限。</p>
        {!!installation.preservedLicenses?.length && <p>保留许可：{installation.preservedLicenses.map(item => item.originalPath).join('、')}</p>}
        {!!installation.issues.length && <p role="status">{installation.issues.join('、')}</p>}
      </div>}
      {!skill.available && <p role="alert">不可用：{skill.reason}</p>}<pre className="config-document">{body || '尚未读取正文'}</pre>
    </> : <p>{selected ? `${selected} 当前不在可用目录中。` : '选择 Skill 查看当前生效来源和正文。'}</p>}
      {selected && (installation || !skill) && <SkillLifecyclePanel key={selected} projectId={projectId} name={selected} installation={installation} boundStages={Object.entries(bindings).filter(([, names]) => names?.includes(selected)).map(([id]) => stages[id as HarnessResearchStageId] || id)} onChanged={loadCatalog} />}
    </section></div>
    <section className="config-binding"><h2>阶段绑定</h2><p className="config-note">为对应阶段选择说明文档。安装与绑定相互独立；实际工具能力仍由项目和角色决定。</p>
      {uninitialized && <p className="config-note">此项目尚未启用研究流程；保存绑定时会初始化阶段配置。</p>}
      <label>研究阶段 <select value={stage} onChange={event => setStage(event.target.value as HarnessResearchStageId)}>{Object.entries(stages).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <div>{skills.filter(item => canBind(item, stage)).map(item => <label key={item.name}><input type="checkbox" checked={bindings[stage]?.includes(item.name) || false} onChange={event => toggle(item.name, event.target.checked)} />{item.name}</label>)}</div>
      {bindings[stage]?.filter(id => !skills.some(item => item.name === id && canBind(item, stage))).map(id => <p key={id}>不可用绑定：{id} <button onClick={() => toggle(id, false)}>移除绑定</button></p>)}
      <button className="hub-small-button" disabled={busy || (!uninitialized && version === undefined)} onClick={() => void save()}>保存绑定</button><button className="hub-small-button is-quiet" onClick={() => void load().catch(cause => setError(readerError(cause)))}>重新读取</button>
    </section>
  </ProjectWorkspaceFrame>;
}
