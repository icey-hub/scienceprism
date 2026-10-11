import { useTranslation } from 'react-i18next';
import type { useAssistantRun } from './useAssistantRun';
import './AssistantSkills.css';
export function AssistantSkillPicker({assistant}:{assistant:ReturnType<typeof useAssistantRun>}) {
 const {t}=useTranslation();
 return (
      <details className="assistant-skills">
        <summary>Skill ({assistant.skillNames.length}/20)</summary>
        <p className="muted">{t('仅发送所选摘要，正文由工具按需读取；选择不会扩大权限。未选择时不启用 Skill。')}</p>
        {assistant.skillsLoading && <div role="status">{t('正在读取 Skill 目录…')}</div>}
        {assistant.skillsError && <div role="alert">{t('Skill 目录读取失败；已有列表可能过期，选择已保留。')} {assistant.skillsError}</div>}
        <button type="button" className="btn ghost" disabled={assistant.skillsLoading} onClick={assistant.refreshSkills}>{t('刷新 Skill 目录')}</button>
        <button type="button" className="btn ghost" disabled={!assistant.skillNames.length || assistant.busy} onClick={() => assistant.setSkillNames([])}>{t('清空 Skill 选择')}</button>
        {!assistant.skillsLoading && !assistant.skillsError && !assistant.skills.length && <p>{t('没有可发现的 Skill。')}</p>}
        <div className="assistant-skill-list">
          {assistant.skills.map(skill => {
            const checked = assistant.skillNames.includes(skill.name);
            return <div className="assistant-skill-item" key={skill.name}>
              <label><input type="checkbox" checked={checked}
                disabled={assistant.busy || (!checked && (!skill.available || assistant.skillNames.length >= 20))}
                onChange={() => assistant.setSkillNames(names => checked ? names.filter(name => name !== skill.name) : [...names, skill.name].sort())} />{skill.name}</label>
              <div>{skill.description || t('未提供摘要')}</div>
              <div className="muted">{skill.source === 'project' ? t('项目 Skill') : t('内置 Skill')} · {skill.relativePath}</div>
              {skill.shadows && <div>{t('覆盖同名内置 Skill')}</div>}
              <div className="muted">{skill.stages.length ? `${t('研究阶段')}：${skill.stages.join(', ')}` : t('通用文本 Skill（不绑定研究阶段）')}</div>
              {!skill.available && <div>{t('不可用')}：{skill.reason || t('未知原因')}</div>}
            </div>;
          })}
          {assistant.skillNames.filter(name => !assistant.skills.some(skill => skill.name === name)).map(name => <label key={name}>
            <input type="checkbox" checked disabled={assistant.busy} onChange={() => assistant.setSkillNames(names => names.filter(item => item !== name))} />
            {name} — {t('当前目录中缺失；请取消或刷新目录')}
          </label>)}
        </div>
      </details>
 );
}
