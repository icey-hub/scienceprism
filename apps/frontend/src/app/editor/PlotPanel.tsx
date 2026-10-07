import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface PlotPanelProps {
  projectId: string;
  plotType: 'bar' | 'line' | 'heatmap';
  plotTitle: string;
  plotFilename: string;
  plotPrompt: string;
  plotRetries: number;
  plotAutoInsert: boolean;
  plotBusy: boolean;
  plotStatus: string;
  plotAssetPath: string;
  imagePrompt: string;
  imageSize: '1024x1024' | '1536x1024' | '1024x1536';
  imageQuality: 'low' | 'medium' | 'high';
  imageBusy: boolean;
  imageStatus: string;
  imageAssetPath: string;
  setPlotType: (value: 'bar' | 'line' | 'heatmap') => void;
  setPlotTitle: (value: string) => void;
  setPlotFilename: (value: string) => void;
  setPlotPrompt: (value: string) => void;
  setPlotRetries: (value: number) => void;
  setPlotAutoInsert: (value: boolean) => void;
  setImagePrompt: (value: string) => void;
  setImageSize: (value: '1024x1024' | '1536x1024' | '1024x1536') => void;
  setImageQuality: (value: 'low' | 'medium' | 'high') => void;
  handlePlotGenerate: () => void;
  handleGptImageGenerate: () => void;
  insertFigureSnippet: (path: string) => void;
}

export function PlotPanel({
  projectId,
  plotType,
  plotTitle,
  plotFilename,
  plotPrompt,
  plotRetries,
  plotAutoInsert,
  plotBusy,
  plotStatus,
  plotAssetPath,
  imagePrompt,
  imageSize,
  imageQuality,
  imageBusy,
  imageStatus,
  imageAssetPath,
  setPlotType,
  setPlotTitle,
  setPlotFilename,
  setPlotPrompt,
  setPlotRetries,
  setPlotAutoInsert,
  setImagePrompt,
  setImageSize,
  setImageQuality,
  handlePlotGenerate,
  handleGptImageGenerate,
  insertFigureSnippet,
}: PlotPanelProps) {
  const { t } = useTranslation();
  const [plotTypeDropdownOpen, setPlotTypeDropdownOpen] = useState(false);
  return (
    <>
      <div className="panel-header">
        <div>{t('绘图')}</div>
      </div>
      <div className="tools-body">
        <div className="tool-section">
          <div className="tool-title">{t('表格 → 图表')}</div>
          <div className="muted">{t('从选区表格生成图表（seaborn）')}</div>
          <div className="field">
            <label>{t('图表类型')}</label>
            <div className="ios-select-wrapper">
              <button className="ios-select-trigger" onClick={() => setPlotTypeDropdownOpen(!plotTypeDropdownOpen)}>
                <span>{{ bar: t('Bar'), line: t('Line'), heatmap: t('Heatmap') }[plotType]}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={plotTypeDropdownOpen ? 'rotate' : ''}>
                  <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              {plotTypeDropdownOpen && (
                <div className="ios-dropdown dropdown-down">
                  {([['bar', t('Bar')], ['line', t('Line')], ['heatmap', t('Heatmap')]] as [string, string][]).map(([val, label]) => (
                    <div key={val} className={`ios-dropdown-item ${plotType === val ? 'active' : ''}`} onClick={() => { setPlotType(val as 'bar' | 'line' | 'heatmap'); setPlotTypeDropdownOpen(false); }}>
                      {label}
                      {plotType === val && (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="field">
            <label>{t('标题 (可选)')}</label>
            <input
              className="input"
              value={plotTitle}
              onChange={(event) => setPlotTitle(event.target.value)}
              placeholder={t('Chart title')}
            />
          </div>
          <div className="field">
            <label>{t('文件名 (可选)')}</label>
            <input
              className="input"
              value={plotFilename}
              onChange={(event) => setPlotFilename(event.target.value)}
              placeholder="plot.png"
            />
          </div>
          <div className="field">
            <label>{t('补充提示 (可选)')}</label>
            <textarea
              className="input"
              value={plotPrompt}
              onChange={(event) => setPlotPrompt(event.target.value)}
              placeholder={t('例如：使用折线图，突出 Method A；加上 legend；设置 y 轴为 Accuracy')}
              rows={2}
            />
          </div>
          <div className="field">
            <label>{t('Debug 重试次数')}</label>
            <input
              className="input"
              type="number"
              min={0}
              max={5}
              value={plotRetries}
              onChange={(event) => setPlotRetries(Math.max(0, Math.min(5, Number(event.target.value) || 0)))}
            />
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={plotAutoInsert}
              onChange={(event) => setPlotAutoInsert(event.target.checked)}
            />
            {t('生成后插入 Figure')}
          </label>
          <div className="row">
            <button className="btn" onClick={handlePlotGenerate} disabled={plotBusy}>
              {plotBusy ? t('生成中...') : t('生成图表')}
            </button>
          </div>
          {plotStatus && <div className="muted">{plotStatus}</div>}
          {plotAssetPath && (
            <div className="vision-result">
              <div className="muted">{t('预览')}</div>
              <img
                src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(plotAssetPath)}`}
                alt={plotAssetPath}
                style={{ width: '100%', borderRadius: '8px' }}
              />
              <div className="row">
                <button className="btn ghost" onClick={() => insertFigureSnippet(plotAssetPath)}>{t('插入图模板')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="tool-section">
          <div className="tool-title">GPT Image 2</div>
          <div className="muted">{t('生成论文示意图或视觉草稿；定量结果图请使用可复现数据绘图。')}</div>
          <div className="field">
            <label>{t('图像描述')}</label>
            <textarea className="input" value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)}
              placeholder={t('描述图中的对象、结构、布局和标注')} rows={5} />
          </div>
          <div className="field">
            <label>{t('尺寸')}</label>
            <select className="input" value={imageSize} onChange={(event) => setImageSize(event.target.value as typeof imageSize)}>
              <option value="1536x1024">1536 × 1024</option>
              <option value="1024x1024">1024 × 1024</option>
              <option value="1024x1536">1024 × 1536</option>
            </select>
          </div>
          <div className="field">
            <label>{t('质量')}</label>
            <select className="input" value={imageQuality} onChange={(event) => setImageQuality(event.target.value as typeof imageQuality)}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </div>
          <div className="row">
            <button className="btn" onClick={handleGptImageGenerate} disabled={imageBusy || !imagePrompt.trim()}>
              {imageBusy ? t('生成中...') : t('生成图像')}
            </button>
          </div>
          {imageStatus && <div className="muted">{imageStatus}</div>}
          {imageAssetPath && (
            <div className="vision-result">
              <div className="muted">{t('预览')}</div>
              <img src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(imageAssetPath)}`} alt={imagePrompt}
                style={{ width: '100%', borderRadius: '8px' }} />
              <div className="row"><button className="btn ghost" onClick={() => insertFigureSnippet(imageAssetPath)}>{t('插入图模板')}</button></div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
