import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebsearch } from './useWebsearch';
import { appendLog } from './modelText';
type Props={controller:ReturnType<typeof useWebsearch>;bibFiles:string[];texFiles:string[];createBibFile:()=>Promise<string|undefined>;insertAtCursor:(text:string)=>void;applyWebsearchInsert:()=>Promise<void>};
export function WebsearchPanel({controller,bibFiles,texFiles,createBibFile,insertAtCursor,applyWebsearchInsert}:Props){
 const {t}=useTranslation();const {websearchQuery,setWebsearchQuery,websearchLog,setWebsearchLog,websearchBusy,setWebsearchBusy,websearchResults,setWebsearchResults,websearchSelected,setWebsearchSelected,websearchParagraph,setWebsearchParagraph,websearchItemNotes,setWebsearchItemNotes,websearchTargetFile,setWebsearchTargetFile,websearchTargetBib,setWebsearchTargetBib,websearchSelectedAll,setWebsearchSelectedAll,runWebsearch,stopWebsearch}=controller;
 const [wsBibDropdownOpen,setWsBibDropdownOpen]=useState(false),[wsTexDropdownOpen,setWsTexDropdownOpen]=useState(false);
 return (<>
                <div className="panel-header">
                  <div>{t('Websearch')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('多点检索')}</div>
                    <div className="field">
                      <label>{t('Query')}</label>
                      <input
                        className="input"
                        value={websearchQuery}
                        onChange={(event) => setWebsearchQuery(event.target.value)}
                        placeholder={t('例如: diffusion editing for safety')}
                      />
                    </div>
                    <div className="row">
                      <button className="btn" onClick={runWebsearch} disabled={websearchBusy}>
                        {websearchBusy ? t('检索中...') : t('开始检索')}
                      </button>
                    </div>
                    {websearchBusy && <button className="btn ghost" onClick={stopWebsearch}>{t('停止后续步骤')}</button>}
                    <div className="websearch-log">
                      {websearchLog.length === 0 ? (
                        <div className="muted">{t('等待查询...')}</div>
                      ) : (
                        websearchLog.map((line, idx) => (
                          <div key={idx} className="websearch-line">{line}</div>
                        ))
                      )}
                    </div>
                    {websearchResults.length > 0 && (
                      <>
                        <div className="row">
                          <label className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={websearchSelectedAll}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setWebsearchSelectedAll(checked);
                                const next: Record<string, boolean> = {};
                                websearchResults.forEach((item) => {
                                  next[item.id] = checked;
                                });
                                setWebsearchSelected(next);
                              }}
                            />
                            {t('全选')}
                          </label>
                          <button
                            className="btn ghost small"
                            onClick={() => {
                              const keys = websearchResults
                                .filter((item) => websearchSelected[item.id])
                                .map((item) => item.citeKey)
                                .filter(Boolean);
                              if (keys.length > 0) {
                                insertAtCursor(`\\cite{${keys.join(',')}}`);
                                appendLog(setWebsearchLog, t('已插入选中引用到光标。'));
                              }
                            }}
                          >
                            {t('插入选中引用')}
                          </button>
                        </div>
                        <div className="tool-list">
                          {websearchResults.map((paper) => (
                            <label key={paper.id} className="tool-item">
                              <input
                                type="checkbox"
                                checked={Boolean(websearchSelected[paper.id])}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setWebsearchSelected((prev) => ({ ...prev, [paper.id]: checked }));
                                }}
                              />
                              <div>
                                <div className="tool-item-title">{paper.title}</div>
                                {paper.summary && <div className="muted">{paper.summary}</div>}
                                {paper.url && <div className="muted">{paper.url}</div>}
                                {paper.citeKey && <div className="muted">{t('cite')}: {paper.citeKey}</div>}
                              </div>
                              <button
                                className="btn ghost small"
                                onClick={() => {
                                  if (paper.citeKey) {
                                    insertAtCursor(`\\cite{${paper.citeKey}}`);
                                    appendLog(setWebsearchLog, t('已插入: {{cite}}', { cite: paper.citeKey }));
                                  }
                                }}
                              >
                                {t('插入引用')}
                              </button>
                            </label>
                          ))}
                        </div>
                        <div className="vision-result">
                          <div className="muted">{t('逐条总结')}</div>
                          <div className="tool-list">
                            {websearchResults.map((paper) => (
                              <div key={paper.id} className="tool-item summary-item">
                                <div>
                                  <div className="tool-item-title">{paper.title}</div>
                                  {paper.citeKey && <div className="muted">{t('cite')}: {paper.citeKey}</div>}
                                </div>
                                <textarea
                                  className="input"
                                  value={websearchItemNotes[paper.id] ?? paper.summary ?? ''}
                                  onChange={(event) =>
                                    setWebsearchItemNotes((prev) => ({ ...prev, [paper.id]: event.target.value }))
                                  }
                                  rows={3}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    {websearchParagraph && (
                      <div className="vision-result">
                        <div className="muted">{t('综合总结')}</div>
                        <textarea
                          className="input"
                          value={websearchParagraph}
                          onChange={(event) => setWebsearchParagraph(event.target.value)}
                          rows={6}
                        />
                      </div>
                    )}
                    <div className="field">
                      <label>{t('Bib 文件')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => setWsBibDropdownOpen(!wsBibDropdownOpen)}>
                          <span>{websearchTargetBib || t('(新建/选择 Bib 文件)')}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={wsBibDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        {wsBibDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            <div className={`ios-dropdown-item ${!websearchTargetBib ? 'active' : ''}`} onClick={() => { setWebsearchTargetBib(''); setWsBibDropdownOpen(false); }}>
                              {t('(新建/选择 Bib 文件)')}
                              {!websearchTargetBib && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                            </div>
                            {bibFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${websearchTargetBib === p ? 'active' : ''}`} onClick={() => { setWebsearchTargetBib(p); setWsBibDropdownOpen(false); }}>
                                {p}
                                {websearchTargetBib === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="btn ghost small" onClick={async () => {
                        const created = await createBibFile();
                        if (created) setWebsearchTargetBib(created);
                      }}>{t('新建 Bib')}</button>
                    </div>
                    <div className="field">
                      <label>{t('插入目标 TeX')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => { setWsTexDropdownOpen(!wsTexDropdownOpen); setWsBibDropdownOpen(false); }}>
                          <span>{websearchTargetFile || '—'}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={wsTexDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {wsTexDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            {texFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${websearchTargetFile === p ? 'active' : ''}`} onClick={() => { setWebsearchTargetFile(p); setWsTexDropdownOpen(false); }}>
                                {p}
                                {websearchTargetFile === p && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="row">
                      <button className="btn" onClick={applyWebsearchInsert} disabled={websearchBusy}>
                        {t('一键写入 Bib + 插入总结')}
                      </button>
                    </div>
                  </div>
                </div>
              </>);
}
