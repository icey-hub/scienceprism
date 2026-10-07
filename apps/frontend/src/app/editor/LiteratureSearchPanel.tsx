import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArxivPaper } from '../../api/editorAdapter';

interface LiteratureSearchPanelProps {
  arxivQuery: string;
  setArxivQuery: (value: string) => void;
  arxivMaxResults: number;
  setArxivMaxResults: (value: number) => void;
  handleArxivSearch: () => void;
  arxivBusy: boolean;
  useLlmSearch: boolean;
  setUseLlmSearch: (value: boolean) => void;
  arxivStatus: string;
  llmSearchOutput: string;
  setLlmSearchOutput: (value: string) => void;
  arxivResults: ArxivPaper[];
  arxivSelected: Record<string, boolean>;
  onSelectPaper: (id: string, selected: boolean) => void;
  bibTarget: string;
  setBibTarget: (value: string) => void;
  bibFiles: string[];
  createBibFile: () => Promise<string | undefined>;
  autoInsertCite: boolean;
  setAutoInsertCite: (value: boolean) => void;
  autoInsertToMain: boolean;
  setAutoInsertToMain: (value: boolean) => void;
  citeTargetFile: string;
  setCiteTargetFile: (value: string) => void;
  texFiles: string[];
  handleArxivApply: () => void;
}

export function LiteratureSearchPanel({
  arxivQuery,
  setArxivQuery,
  arxivMaxResults,
  setArxivMaxResults,
  handleArxivSearch,
  arxivBusy,
  useLlmSearch,
  setUseLlmSearch,
  arxivStatus,
  llmSearchOutput,
  setLlmSearchOutput,
  arxivResults,
  arxivSelected,
  onSelectPaper,
  bibTarget,
  setBibTarget,
  bibFiles,
  createBibFile,
  autoInsertCite,
  setAutoInsertCite,
  autoInsertToMain,
  setAutoInsertToMain,
  citeTargetFile,
  setCiteTargetFile,
  texFiles,
  handleArxivApply
}: LiteratureSearchPanelProps) {
  const { t } = useTranslation();
  const [bibTargetDropdownOpen, setBibTargetDropdownOpen] = useState(false);
  const [citeTargetDropdownOpen, setCiteTargetDropdownOpen] = useState(false);
  return (
  <>
    <div className="panel-header">
      <div>{t('论文检索')}</div>
    </div>
    <div className="tools-body">
      <div className="tool-section">
        <div className="tool-title">{t('arXiv 检索')}</div>
        <div className="field">
          <label>{t('关键词')}</label>
          <input
            className="input"
            value={arxivQuery}
            onChange={(event) => setArxivQuery(event.target.value)}
            placeholder={t('例如: diffusion transformer compression')}
          />
        </div>
        <div className="row">
          <input
            className="input small"
            type="number"
            min={1}
            max={10}
            value={arxivMaxResults}
            onChange={(event) => setArxivMaxResults(Number(event.target.value) || 5)}
          />
          <button className="btn ghost" onClick={handleArxivSearch} disabled={arxivBusy}>
            {arxivBusy ? t('检索中...') : useLlmSearch ? t('LLM 检索') : t('检索')}
          </button>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={useLlmSearch}
            onChange={(event) => setUseLlmSearch(event.target.checked)}
          />
          {t('使用 Websearch 模型')}
        </label>
        {arxivStatus && <div className="muted">{arxivStatus}</div>}
        {llmSearchOutput && (
          <div className="vision-result">
            <div className="muted">{t('LLM 原始输出')}</div>
            <textarea
              className="input"
              value={llmSearchOutput}
              onChange={(event) => setLlmSearchOutput(event.target.value)}
              rows={5}
            />
          </div>
        )}
        {arxivResults.length > 0 && (
          <div className="tool-list">
            {arxivResults.map((paper) => (
              <label key={paper.arxivId} className="tool-item">
                <input
                  type="checkbox"
                  checked={Boolean(arxivSelected[paper.arxivId])}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    onSelectPaper(paper.arxivId, checked);
                  }}
                />
                <div>
                  <div className="tool-item-title">{paper.title}</div>
                  <div className="muted">{paper.authors?.join(', ') || t('Unknown authors')}</div>
                  <div className="muted">{paper.arxivId}</div>
                </div>
              </label>
            ))}
          </div>
        )}
        <div className="field">
          <label>{t('Bib 文件')}</label>
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={() => setBibTargetDropdownOpen(!bibTargetDropdownOpen)}>
              <span>{bibTarget || t('(新建/选择 Bib 文件)')}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={bibTargetDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {bibTargetDropdownOpen && (
              <div className="ios-dropdown dropdown-down">
                <div className={`ios-dropdown-item ${bibTarget === '' ? 'active' : ''}`} onClick={() => { setBibTarget(''); setBibTargetDropdownOpen(false); }}>
                  {t('(新建/选择 Bib 文件)')}
                  {bibTarget === '' && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </div>
                {bibFiles.map((p) => (
                  <div key={p} className={`ios-dropdown-item ${bibTarget === p ? 'active' : ''}`} onClick={() => { setBibTarget(p); setBibTargetDropdownOpen(false); }}>
                    {p}
                    {bibTarget === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="btn ghost" onClick={async () => {
            const created = await createBibFile();
            if (created) setBibTarget(created);
          }}>{t('新建 Bib')}</button>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={autoInsertCite}
            onChange={(event) => setAutoInsertCite(event.target.checked)}
          />
          {t('自动插入引用到当前 TeX')}
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={autoInsertToMain}
            onChange={(event) => setAutoInsertToMain(event.target.checked)}
          />
          {t('AI 插入引用到指定 TeX')}
        </label>
        {autoInsertToMain && (
          <div className="field">
            <label>{t('引用插入目标')}</label>
            <div className="ios-select-wrapper">
              <button className="ios-select-trigger" onClick={() => setCiteTargetDropdownOpen(!citeTargetDropdownOpen)}>
                <span>{citeTargetFile || texFiles[0] || 'main.tex'}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={citeTargetDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {citeTargetDropdownOpen && (
                <div className="ios-dropdown dropdown-down">
                  {texFiles.map((p) => (
                    <div key={p} className={`ios-dropdown-item ${citeTargetFile === p ? 'active' : ''}`} onClick={() => { setCiteTargetFile(p); setCiteTargetDropdownOpen(false); }}>
                      {p}
                      {citeTargetFile === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={handleArxivApply} disabled={arxivBusy}>
            {t('写入 Bib / 插入引用')}
          </button>
        </div>
      </div>
    </div>
  </>
  );
}
