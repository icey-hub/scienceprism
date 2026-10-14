import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import ChatPage from './workspace/ChatPage';
import ToolPage from './workspace/ToolPage';
import LandingPage from './LandingPage';
import ProjectPage from './ProjectPage';
import CollabJoinPage from './CollabJoinPage';
import ProjectDashboardPage from './ProjectDashboardPage';
import McpPage from './project/McpPage';
import ModelsPage from './project/ModelsPage';
import AgentsPage from './project/AgentsPage';
import SkillsPage from './project/SkillsPage';
import ExplorationPage from './project/ExplorationPage';
import TaskDetailPage from './project/TaskDetailPage';

import { researchHref } from './research/researchLocation';
import { isWorkspaceTool, workspaceToolHref } from './components/workspaceTools';

const EditorPage = lazy(() => import('./EditorPage'));
const ResearchPage = lazy(() => import('./workspace/ResearchPage'));
const PaperReaderPage = lazy(() => import('./papers/PaperReaderPage'));
const DataPage = lazy(() => import('./lab/DataPage'));
const FigurePage = lazy(() => import('./lab/FigurePage'));
const PaperSearchPage = lazy(() => import('./papers/PaperSearchPage'));

function LegacyResearchRedirect() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return <Navigate to={researchHref(projectId)} replace />;
}

function EditorSession() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [params] = useSearchParams();
  const tool = params.get('tool');
  if (isWorkspaceTool(tool)) return <Navigate replace to={workspaceToolHref(projectId, tool)} />;
  return <EditorPage key={projectId} />;
}

export default function App() {
  return (
    <Suspense fallback={<p role="status">正在打开页面…</p>}><Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/projects" element={<ProjectPage />} />
      <Route path="/project/:projectId" element={<ProjectDashboardPage />} />
      <Route path="/project/:projectId/:view" element={<ProjectDashboardPage />} />
      <Route path="/project/:projectId/chat" element={<ChatPage />} />
      <Route path="/project/:projectId/lab/data" element={<DataPage />} />
      <Route path="/project/:projectId/lab/figures" element={<FigurePage />} />
      <Route path="/project/:projectId/papers/search" element={<PaperSearchPage />} />
      <Route path="/project/:projectId/papers/:paperId/read" element={<PaperReaderPage />} />
      <Route path="/project/:projectId/tools/:tool" element={<ToolPage />} />
      <Route path="/project/:projectId/mcp" element={<McpPage />} />
      <Route path="/project/:projectId/models" element={<ModelsPage />} />
      <Route path="/project/:projectId/agents" element={<AgentsPage />} />
      <Route path="/project/:projectId/skills" element={<SkillsPage />} />
      <Route path="/project/:projectId/explore" element={<ExplorationPage />} />
      <Route path="/project/:projectId/tasks/:taskId" element={<TaskDetailPage />} />
      <Route path="/editor/:projectId" element={<EditorSession />} />
      <Route path="/editor/:projectId/research" element={<LegacyResearchRedirect />} />
      <Route path="/editor/:projectId/research/:stage" element={<ResearchPage />} />
      <Route path="/research/:projectId" element={<LegacyResearchRedirect />} />
      <Route path="/collab" element={<CollabJoinPage />} />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes></Suspense>
  );
}
