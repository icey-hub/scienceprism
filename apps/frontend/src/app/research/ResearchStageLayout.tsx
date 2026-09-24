import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ResearchStageNavigation } from './ResearchStageNavigation';
import {
  getResearchStage,
  STAGE_STATUS_LABELS,
  type ResearchStageId,
  type ResearchStageStatus
} from './researchStages';
import './research.css';

export interface ResearchStageLayoutProps {
  projectId: string;
  projectName: string;
  stage: ResearchStageId;
  embedded?: boolean;
  stageStatuses?: Partial<Record<ResearchStageId, ResearchStageStatus>>;
  harnessState?: 'ready' | 'checking' | 'unavailable';
  roleSummaries?: {
    id: string;
    authority: string;
    capabilities: string[];
    skills: string[];
  }[] | null;
  busy?: boolean;
  context?: ReactNode;
  children: ReactNode;
  onNavigate: (stage: ResearchStageId) => void;
  onBackToEditor: () => void;
  onRefresh?: () => void;
  onApprove?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}

export function ResearchStageLayout({
  projectId,
  projectName,
  stage,
  embedded = false,
  stageStatuses = {},
  harnessState = 'checking',
  roleSummaries = null,
  busy = false,
  context,
  children,
  onNavigate,
  onBackToEditor,
  onRefresh,
  onApprove,
  onPrevious,
  onNext
}: ResearchStageLayoutProps) {
  const definition = getResearchStage(stage);
  const status = stageStatuses[stage] || 'active';
  const harnessLabel = harnessState === 'ready'
    ? '已连接'
    : harnessState === 'unavailable'
      ? '未配置'
      : '检查中';

  const stageMain = (
    <main className="research-stage-main">
      <header className="research-stage-heading">
        <div>
          <span className="research-overline">STAGE {String(definition.index).padStart(2, '0')} / 08</span>
          <h2>{definition.label}</h2>
          <p>{definition.description}</p>
        </div>
        <span className={`research-status-badge is-${status}`}>{STAGE_STATUS_LABELS[status]}</span>
      </header>
      <div className="research-stage-content">{children}</div>
      <footer className="research-stage-footer">
        <button className="research-button research-button-quiet" disabled={!onPrevious || busy} onClick={onPrevious} type="button">上一阶段</button>
        <div>
          {onApprove && <button className="research-button research-button-primary" disabled={busy || status === 'locked'} onClick={onApprove} type="button">人工确认</button>}
          <button className="research-button research-button-quiet" disabled={!onNext || busy} onClick={onNext} type="button">下一阶段</button>
        </div>
      </footer>
    </main>
  );

  if (embedded) {
    return <div className="research-stage-shell is-embedded">{stageMain}</div>;
  }

  return (
    <div className="research-stage-shell">
      <header className="research-stage-topbar">
        <div className="research-stage-project">
          <button className="research-icon-button" onClick={onBackToEditor} type="button" aria-label="返回论文编辑器" title="返回论文编辑器">&larr;</button>
          <div>
            <span className="research-overline">SCIENCEPRISM / RESEARCH</span>
            <h1>{projectName}</h1>
          </div>
        </div>
        <div className="research-stage-topbar-actions">
          <Link className="research-button research-button-quiet" to={`/project/${encodeURIComponent(projectId)}`}>驾驶舱</Link>
          <Link className="research-button research-button-quiet" to={`/project/${encodeURIComponent(projectId)}/runs`}>运行中心</Link>
          <span className={`research-harness-status is-${harnessState}`}>
            <i aria-hidden="true" /> DeepSeek Harness <small>{harnessLabel}</small>
          </span>
          {onRefresh && <button className="research-button research-button-quiet" disabled={busy} onClick={onRefresh} type="button">刷新</button>}
        </div>
      </header>

      <div className="research-stage-layout">
        <aside className="research-stage-sidebar">
          <div className="research-sidebar-heading">
            <span className="research-overline">RESEARCH LOOP</span>
            <strong>研究流程</strong>
          </div>
          <ResearchStageNavigation activeStage={stage} stageStatuses={stageStatuses} onNavigate={onNavigate} />
          <p className="research-human-note"><b>H</b> 每个阶段都需要人工确认，Skill 不能越过审批。</p>
          {roleSummaries && roleSummaries.length > 0 && (
            <section className="research-role-summary" aria-label="本阶段运行角色">
              <span className="research-overline">RUNNING ROLE</span>
              {roleSummaries.map((role) => (
                <div className="research-role-summary-item" key={role.id}>
                  <strong>{role.id}</strong>
                  <dl>
                    <div>
                      <dt>权限</dt>
                      <dd>{role.authority}</dd>
                    </div>
                    <div>
                      <dt>能力</dt>
                      <dd>{role.capabilities.length ? role.capabilities.join(', ') : '无'}</dd>
                    </div>
                    <div>
                      <dt>可用 Skill</dt>
                      <dd>{role.skills.length ? role.skills.join(', ') : '无'}</dd>
                    </div>
                  </dl>
                </div>
              ))}
              <p className="research-role-summary-note">角色只能收窄权限，不能扩大；审批仍由人工完成。</p>
            </section>
          )}
        </aside>

        {stageMain}

        {context && <aside className="research-context-sidebar">{context}</aside>}
      </div>
    </div>
  );
}
