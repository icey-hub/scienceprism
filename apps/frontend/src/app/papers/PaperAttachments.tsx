import { Download, Upload } from 'lucide-react';
import type { usePaperReader } from './usePaperReader';

export function PaperAttachments({ controller }: { controller: ReturnType<typeof usePaperReader> }) {
  const state = controller.attachments;
  return <section className="reader-attachments" aria-label="PDF 附件">
    <div className="reader-attachment-actions"><button disabled={controller.busy || !state} onClick={() => void controller.download()}><Download size={15} />获取开放全文</button><label className="reader-upload"><Upload size={15} />导入本地 PDF<input type="file" accept="application/pdf,.pdf" aria-label="导入本地 PDF" disabled={controller.busy || !state} onChange={event => { const file = event.target.files?.[0]; if (file) void controller.upload(file); event.target.value = ''; }} /></label>{!!state?.attachments.length && <button disabled={controller.busy} onClick={() => void controller.download(true)}>检查新版本</button>}</div>
    {controller.busy && <p role="status">正在处理附件…</p>}
    {state?.jobs.slice(-3).reverse().map(job => <div className="reader-download-job" key={job.id}><span>{{ queued: '等待下载', running: '下载中', completed: '下载完成', cancelled: '已取消', failed: '下载失败' }[job.status]} · {(job.receivedBytes / 1024 / 1024).toFixed(1)} MB{job.totalBytes ? ` / ${(job.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}</span>{['queued', 'running'].includes(job.status) && <button onClick={() => void controller.cancel(job.id)}>取消</button>}{job.error && <p role="alert">{job.error.message}</p>}</div>)}
    {!state?.attachments.length && <p className="reader-muted">PDF 会保存在本项目。自动获取支持 arXiv、PMC、Europe PMC 和 Zenodo；其他来源可导入你已取得的 PDF。</p>}
  </section>;
}
