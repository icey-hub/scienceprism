import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePaperReview } from './usePaperReview';
export function ReviewPanel({controller}:{controller:ReturnType<typeof usePaperReview>}){
 const {t}=useTranslation();const {reviewNotes,reviewBusy,reviewError,peerReview,consistencyReview,citationReview,compileReview}=controller;
 return <>{reviewError && <p role="alert">{reviewError}</p>}{reviewBusy && <p role="status">{t('正在执行评审…')}</p>}<>
                <div className="panel-header">
                  <div>{t('Review')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('质量检查')}</div>
                    <div className="tool-desc">{t('AI 辅助检查论文质量，发现潜在问题')}</div>
                    <div className="review-buttons">
                      <button
                        className="review-btn"
                        onClick={peerReview} disabled={reviewBusy}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg></span>
                        <span className="review-btn-label">{t('详细评审报告')}</span>
                        <span className="review-btn-desc">{t('阅读项目并输出完整审稿意见')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={consistencyReview} disabled={reviewBusy}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>
                        <span className="review-btn-label">{t('一致性检查')}</span>
                        <span className="review-btn-desc">{t('检查术语、符号一致性')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={citationReview} disabled={reviewBusy}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>
                        <span className="review-btn-label">{t('引用缺失')}</span>
                        <span className="review-btn-desc">{t('查找需要引用的论述')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={compileReview} disabled={reviewBusy}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>
                        <span className="review-btn-label">{t('编译日志总结')}</span>
                        <span className="review-btn-desc">{t('总结错误并给出修复建议')}</span>
                      </button>
                    </div>
                  </div>
                  {reviewNotes.length > 0 && (
                    <div className="tool-section">
                      <div className="tool-title">{t('结果')}</div>
                      {reviewNotes.map((note, idx) => (
                        <div key={`${note.title}-${idx}`} className="review-item">
                          <div className="review-title">{note.title}</div>
                          <div className="review-content markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </></>;
}
