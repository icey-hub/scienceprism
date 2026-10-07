import type { ProjectSkill, ResearchDirection, ResearchStageId, SkillBindings } from '../researchStages';
import { RESEARCH_STAGES } from '../researchStages';

export interface DirectionStageProps {
  value: ResearchDirection;
  skills: readonly ProjectSkill[];
  skillBindings: SkillBindings;
  busy?: boolean;
  onChange: (next: ResearchDirection) => void;
  onSave: () => void;
  onOpenSkillCatalog: () => void;
  onSetSkillStageBinding: (skillName: string, stage: ResearchStageId, enabled: boolean) => void;
}

const SOURCE_LABELS = {
  'built-in': '内置',
  project: '项目',
} as const;

function isBound(bindings: SkillBindings, stage: ResearchStageId, skillName: string) {
  return bindings[stage]?.includes(skillName) || false;
}

export function DirectionStage({
  value,
  skills,
  skillBindings,
  busy = false,
  onChange,
  onSave,
  onOpenSkillCatalog,
  onSetSkillStageBinding
}: DirectionStageProps) {
  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">HUMAN DIRECTION</span>
            <h3>定义研究问题</h3>
          </div>
          <span className="research-human-chip">H 人工主导</span>
        </div>
        <div className="research-form-grid">
          <label className="research-field research-field-wide">
            <span>核心研究问题 <em>必填</em></span>
            <textarea value={value.question} rows={4} placeholder="例如：如何降低长上下文检索增强生成中的事实幻觉？" onChange={(event) => onChange({ ...value, question: event.target.value })} />
          </label>
          <label className="research-field">
            <span>种子关键词 <small>逗号分隔</small></span>
            <input value={value.keywords.join(', ')} placeholder="RAG, factuality, long context" onChange={(event) => onChange({ ...value, keywords: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
          </label>
          <label className="research-field">
            <span>研究边界</span>
            <input value={value.scope} placeholder="任务、领域、时间范围或排除项" onChange={(event) => onChange({ ...value, scope: event.target.value })} />
          </label>
          <label className="research-field research-field-wide">
            <span>可证伪条件 <small>可选</small></span>
            <textarea aria-describedby="direction-falsification-help" value={value.falsificationCondition || ''} rows={3} maxLength={2000} disabled={busy} placeholder="例如：在固定数据集和基线下，所提方法未降低事实错误率，则不支持该假设。" onChange={(event) => onChange({ ...value, falsificationCondition: event.target.value })} />
            <small id="direction-falsification-help">写明什么可观察结果会否定研究假设。保存后可修改或清空；填写条件不代表假设已获验证。</small>
          </label>
          <label className="research-field research-field-wide">
            <span>给 AI 的工作备注 <small>可选</small></span>
            <textarea value={value.notes} rows={3} placeholder="保留哪些前提？更重视哪类证据？" onChange={(event) => onChange({ ...value, notes: event.target.value })} />
          </label>
        </div>
        <div className="research-panel-footer">
          <p>方向由人定义，AI 只负责补充、整理和追溯。</p>
          <button className="research-button research-button-primary" disabled={busy || !value.question.trim()} onClick={onSave} type="button">保存研究方向</button>
        </div>
      </section>

      <section className="research-panel research-skills-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">PROJECT SKILLS</span>
            <h3>项目 Skill</h3>
          </div>
          <button className="research-button research-button-quiet" disabled={busy} onClick={onOpenSkillCatalog} title="导入包含 SKILL.md 的 Skill 文件夹" type="button">导入 Skill 文件夹</button>
        </div>
        <p className="research-panel-copy">Skill 会在绑定的研究 Agent 阶段加载，只提供工作建议，不能修改质量门禁或人工审批。</p>
        {skills.length === 0 ? (
          <div className="research-empty-inline">当前项目没有可用 Skill。请先添加或刷新已安装的 Skill。</div>
        ) : (
          <div className="research-skill-catalog">
            {skills.map((skill) => {
              const isAvailable = skill.available !== false;
              return (
                <article className="research-skill-row" key={skill.name}>
                  <div className="research-skill-summary">
                    <div>
                      <strong>{skill.name}</strong>
                      <span>{SOURCE_LABELS[skill.source || 'built-in']}</span>
                      {!isAvailable && <span className="research-skill-unavailable">不可用</span>}
                    </div>
                    <p>{skill.description}</p>
                  </div>
                  {skill.stages.includes('direction') ? (
                    <label className="research-check-row">
                      <input
                        checked={isBound(skillBindings, 'direction', skill.name)}
                        disabled={busy || !isAvailable}
                        onChange={(event) => onSetSkillStageBinding(skill.name, 'direction', event.target.checked)}
                        type="checkbox"
                      />
                      <span>在本阶段启用</span>
                    </label>
                  ) : <span className="research-skill-unavailable">方向由研究者填写；请在下方绑定实际运行阶段</span>}
                  <details className="research-skill-binding-details">
                    <summary>绑定其他阶段</summary>
                    <fieldset disabled={busy || !isAvailable}>
                      <legend className="sr-only">{skill.name} 的阶段绑定</legend>
                      <div className="research-skill-binding-grid">
                        {RESEARCH_STAGES.filter((stage) => skill.stages.includes(stage.harnessId === 'ideation' ? 'innovation' : stage.id)).map((stage) => (
                          <label key={stage.id}>
                            <input
                              checked={isBound(skillBindings, stage.id, skill.name)}
                              onChange={(event) => onSetSkillStageBinding(skill.name, stage.id, event.target.checked)}
                              type="checkbox"
                            />
                            <span>{stage.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
