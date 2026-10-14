import { Link } from 'react-router-dom';
import { useProjectDocuments } from '../workspace/useProjectDocuments';
import { useImageTool } from '../workspace/useImageTool';
import './FigureWritingTools.css';

/** Reuses the existing document version transaction; the editor stays independent. */
export function FigureWritingTools({ projectId, assetPath }: { projectId: string; assetPath?: string }) {
  const docs = useProjectDocuments(projectId);
  const image = useImageTool(docs);
  const canInsert = !!docs.path && !docs.busy && !docs.loading;
  return <section className="figure-writing-tools" aria-label="写作与图像草稿">
    {docs.error && <p role="alert" className="hub-error">{docs.error}</p>}
    {docs.notice && <p role="status">{docs.notice}</p>}
    <div className="figure-document-target">
      <label>目标文稿<select aria-label="科研图目标文稿" value={docs.path} onChange={event => docs.setPath(event.target.value)} disabled={docs.busy || docs.loading}>
        <option value="">{docs.loading ? '正在读取文稿…' : '选择 TeX 文稿'}</option>
        {docs.texFiles.map(file => <option key={file} value={file}>{file}</option>)}
      </select></label>
      {assetPath && <button className="hub-small-button" disabled={!canInsert} onClick={() => image.insertFigureSnippet(assetPath)}>插入图模板</button>}
      {docs.path && <Link to={`/editor/${encodeURIComponent(projectId)}?file=${encodeURIComponent(docs.path)}`}>打开文稿 ↗</Link>}
      {!docs.loading && !docs.texFiles.length && <span>项目还没有 TeX 文稿，可先在写作页创建。</span>}
    </div>
    <details className="figure-image-draft">
      <summary>AI 图像草稿 · GPT Image 2</summary>
      <p>用文字生成论文示意图或视觉草稿，保存为 PNG。</p>
      <label>图像描述<textarea rows={4} value={image.imagePrompt} onChange={event => image.setImagePrompt(event.target.value)} disabled={image.imageBusy} placeholder="描述图中的对象、结构、布局和标注" /></label>
      <div className="figure-image-settings">
        <label>尺寸<select value={image.imageSize} onChange={event => image.setImageSize(event.target.value as typeof image.imageSize)} disabled={image.imageBusy}>
          <option value="1536x1024">1536 × 1024</option><option value="1024x1024">1024 × 1024</option><option value="1024x1536">1024 × 1536</option>
        </select></label>
        <label>质量<select value={image.imageQuality} onChange={event => image.setImageQuality(event.target.value as typeof image.imageQuality)} disabled={image.imageBusy}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select></label>
        <button className="hub-small-button" disabled={image.imageBusy || !image.imagePrompt.trim()} onClick={() => void image.handleGptImageGenerate()}>{image.imageBusy ? '生成中…' : '生成图像'}</button>
      </div>
      {image.imageStatus && <p role="status">{image.imageStatus}</p>}
      {image.imageAssetPath && <div className="figure-image-result">
        <img src={`/api/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(image.imageAssetPath)}`} alt={image.imagePrompt} />
        <button className="hub-small-button is-quiet" disabled={!canInsert} onClick={() => image.insertFigureSnippet(image.imageAssetPath)}>插入图像模板</button>
      </div>}
    </details>
  </section>;
}
