import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import EditorPage from './EditorPage';
import LandingPage from './LandingPage';
import ProjectPage from './ProjectPage';
import CollabJoinPage from './CollabJoinPage';

function LegacyResearchRedirect() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return <Navigate to={`/editor/${projectId}/research/direction`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/projects" element={<ProjectPage />} />
      <Route path="/editor/:projectId" element={<EditorPage />} />
      <Route path="/editor/:projectId/research" element={<Navigate to="direction" replace />} />
      <Route path="/editor/:projectId/research/:stage" element={<EditorPage />} />
      <Route path="/research/:projectId" element={<LegacyResearchRedirect />} />
      <Route path="/collab" element={<CollabJoinPage />} />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}
