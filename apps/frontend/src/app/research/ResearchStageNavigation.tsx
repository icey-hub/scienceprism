import {
  RESEARCH_STAGES,
  STAGE_STATUS_LABELS,
  type ResearchStageId,
  type ResearchStageStatus
} from './researchStages';

export interface ResearchStageNavigationProps {
  activeStage: ResearchStageId;
  stageStatuses?: Partial<Record<ResearchStageId, ResearchStageStatus>>;
  onNavigate: (stage: ResearchStageId) => void;
}

export function ResearchStageNavigation({
  activeStage,
  stageStatuses = {},
  onNavigate
}: ResearchStageNavigationProps) {
  return (
    <nav className="research-stage-navigation" aria-label="研究阶段">
      {RESEARCH_STAGES.map((stage) => {
        const status = stageStatuses[stage.id] || (stage.id === activeStage ? 'active' : 'locked');
        const isActive = stage.id === activeStage;

        return (
          <button
            aria-current={isActive ? 'page' : undefined}
            className={`research-stage-navigation-item is-${status}${isActive ? ' is-active' : ''}`}
            key={stage.id}
            onClick={() => onNavigate(stage.id)}
            type="button"
          >
            <span className="research-stage-navigation-index" aria-hidden="true">
              {status === 'complete' ? 'OK' : String(stage.index).padStart(2, '0')}
            </span>
            <span className="research-stage-navigation-copy">
              <strong>{stage.label}</strong>
              <small>{stage.description}</small>
            </span>
            <span className="research-stage-navigation-status">{STAGE_STATUS_LABELS[status]}</span>
          </button>
        );
      })}
    </nav>
  );
}
