import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import EditorPage from './EditorPage';
import LandingPage from './LandingPage';
import ProjectPage from './ProjectPage';
import CollabJoinPage from './CollabJoinPage';
import ProjectDashboardPage from './ProjectDashboardPage';
import AgentsPage from './project/AgentsPage';
import SkillsPage from './project/SkillsPage';
import ExplorationPage from './project/ExplorationPage';
import TaskDetailPage from './project/TaskDetailPage';

import { researchHref } from './research/researchLocation';

function LegacyResearchRedirect() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return <Navigate to={researchHref(projectId)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/projects" element={<ProjectPage />} />
      <Route path="/project/:projectId" element={<ProjectDashboardPage />} />
      <Route path="/project/:projectId/:view" element={<ProjectDashboardPage />} />
      <Route path="/project/:projectId/agents" element={<AgentsPage />} />
      <Route path="/project/:projectId/skills" element={<SkillsPage />} />
      <Route path="/project/:projectId/explore" element={<ExplorationPage />} />
      <Route path="/project/:projectId/tasks/:taskId" element={<TaskDetailPage />} />
      <Route path="/editor/:projectId" element={<EditorPage />} />
      <Route path="/editor/:projectId/research" element={<LegacyResearchRedirect />} />
      <Route path="/editor/:projectId/research/:stage" element={<EditorPage />} />
      <Route path="/research/:projectId" element={<LegacyResearchRedirect />} />
      <Route path="/collab" element={<CollabJoinPage />} />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}
