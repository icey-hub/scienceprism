import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ResearchWorkspacePage, { type ResearchWorkspaceState } from '../ResearchWorkspacePage';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { ResearchStageNavigation } from '../research/ResearchStageNavigation';
import { isResearchStageId } from '../research/researchStages';
import { workspaceModel } from './workspaceModel';
import './WorkspacePages.css';
import { ResearchAutomationPanel } from '../project/ResearchAutomationPanel';
export default function ResearchPage(){const {projectId=''}=useParams();return <ResearchWorkspace key={projectId} projectId={projectId}/>;}
function ResearchWorkspace({projectId}:{projectId:string}){
 const {stage='direction'}=useParams(),navigate=useNavigate();const [state,setState]=useState<ResearchWorkspaceState|null>(null);
 return <ProjectWorkspaceFrame projectId={projectId} projectName={state?.projectName||projectId} active="research" title="研究进展"><div className="standalone-research"><ResearchAutomationPanel projectId={projectId}/><ResearchStageNavigation activeStage={isResearchStageId(stage)?stage:'direction'} stageStatuses={state?.stageStatuses} onNavigate={next=>navigate(`/editor/${projectId}/research/${next}`)}/><ResearchWorkspacePage embedded onStateChange={setState} llmConfig={workspaceModel()}/></div></ProjectWorkspaceFrame>;
}
