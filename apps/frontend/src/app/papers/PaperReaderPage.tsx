import { lazy, Suspense, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BookOpen, ChevronLeft } from 'lucide-react';
import { ProjectWorkspaceFrame } from '../components/ProjectWorkspaceFrame';
import { usePaperReader } from './usePaperReader';
import { PaperAttachments } from './PaperAttachments';
import { PdfReadingWorkspace } from './PdfReadingWorkspace';
import type { CitationReadingSource } from '../../api/manuscriptCitationAdapter';
import '../ProjectDashboard.css';
import './PaperReader.css';

const PaperCitationPanel = lazy(() => import('./PaperCitationPanel'));

export default function PaperReaderPage() {
  const { projectId = '', paperId = '' } = useParams();
  return <PaperReader key={`${projectId}:${paperId}`} projectId={projectId} paperId={paperId} />;
}
function PaperReader({ projectId, paperId }: { projectId: string; paperId: string }) {
  const [showCitation, setShowCitation] = useState(false);
  const [readingSource, setReadingSource] = useState<CitationReadingSource | null>(null);
  const [citationSource, setCitationSource] = useState<CitationReadingSource | undefined>();
  const controller = usePaperReader(projectId, paperId);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('attachment');
  const attachment = controller.attachments?.attachments.find(item => item.id === selectedId) || controller.attachments?.attachments.at(-1);
  return <ProjectWorkspaceFrame projectId={projectId} projectName={controller.projectName} active="library" title="文献阅读">
    <div className="paper-reader">
      <header className="reader-heading"><Link to={`/project/${encodeURIComponent(projectId)}/library`} aria-label="返回文献库"><ChevronLeft size={19} /></Link><div><h1>{controller.paper?.title || '文献阅读'}</h1><p>{controller.paper?.authors.slice(0, 4).join(' · ')}{controller.paper?.year ? ` · ${controller.paper.year}` : ''}{controller.paper?.venue ? ` · ${controller.paper.venue}` : ''}</p></div>{attachment && <select aria-label="PDF 附件版本" value={attachment.id} onChange={event => setParams({ attachment: event.target.value })}>{controller.attachments?.attachments.map(item => <option key={item.id} value={item.id}>{item.filename} · {item.pageCount} 页 · {new Date(item.createdAt).toLocaleDateString()}</option>)}</select>}<button onClick={() => { setCitationSource(readingSource && readingSource.attachmentId === attachment?.id ? readingSource : undefined); setShowCitation(value => !value); }} disabled={!controller.paper}>引用</button></header>
      {showCitation && controller.paper && <Suspense fallback={<p>正在读取引用选项…</p>}><PaperCitationPanel key={`${projectId}:${controller.paper.id}`} projectId={projectId} paper={controller.paper} readingSource={citationSource} onClose={() => setShowCitation(false)} /></Suspense>}
      {controller.error && <p role="alert" className="reader-error">{controller.error}</p>}
      {selectedId && attachment?.id !== selectedId && <p role="status">原附件不可用，当前显示此论文的最新附件。</p>}
      {attachment ? <><details className="reader-attachment-details"><summary>附件与来源 · {attachment.filename} · {(attachment.byteLength / 1024 / 1024).toFixed(1)} MB</summary><PaperAttachments controller={controller} /><p className="reader-muted">文件 SHA256：{attachment.sha256}<br />{attachment.sourceUrl || '本地导入'}</p></details><PdfReadingWorkspace key={attachment.id} projectId={projectId} paperId={paperId} attachment={attachment} onCitationSourceChange={setReadingSource} /></> : <div className="reader-no-file"><BookOpen size={42} strokeWidth={1.2} /><h2>把论文带进阅读空间</h2><p>获取开放全文，或导入本地 PDF。选中原文后，右侧可以翻译和记录阅读笔记。</p><PaperAttachments controller={controller} /></div>}
    </div>
  </ProjectWorkspaceFrame>;
}
