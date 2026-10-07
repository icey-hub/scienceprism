import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface VisionPanelProps {
  visionMode: 'equation' | 'table' | 'figure' | 'algorithm' | 'ocr';
  setVisionMode: (value: 'equation' | 'table' | 'figure' | 'algorithm' | 'ocr') => void;
  visionFile: File | null;
  setVisionFile: (value: File | null) => void;
  visionResult: string;
  setVisionResult: (value: string) => void;
  visionPreviewUrl: string;
  setVisionPreviewUrl: (value: string) => void;
  visionPrompt: string;
  setVisionPrompt: (value: string) => void;
  visionBusy: boolean;
  handleVisionSubmit: () => void;
  handleVisionInsert: () => void;
}

export function VisionPanel({
  visionMode,
  setVisionMode,
  visionFile,
  setVisionFile,
  visionResult,
  setVisionResult,
  visionPreviewUrl,
  setVisionPreviewUrl,
  visionPrompt,
  setVisionPrompt,
  visionBusy,
  handleVisionSubmit,
  handleVisionInsert
}: VisionPanelProps) {
  const { t } = useTranslation();
  const [visionModeDropdownOpen, setVisionModeDropdownOpen] = useState(false);
  return (
    <>
      <div className="panel-header">
        <div>{t('图像识别')}</div>
        <div className="panel-actions">
          <button className="btn ghost" onClick={() => setVisionResult('')}>{t('清空结果')}</button>
        </div>
      </div>
      <div className="tools-body">
        <div className="tool-section">
          <div className="tool-title">{t('图像转 LaTeX')}</div>
          <div className="field">
            <label>{t('识别类型')}</label>
            <div className="ios-select-wrapper">
              <button className="ios-select-trigger" onClick={() => setVisionModeDropdownOpen(!visionModeDropdownOpen)}>
                <span>{({'equation':t('公式'),'table':t('表格'),'figure':t('图像 + 图注'),'algorithm':t('算法'),'ocr':t('仅提取文字')} as Record<string,string>)[visionMode]}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={visionModeDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {visionModeDropdownOpen && (
                <div className="ios-dropdown dropdown-down">
                  {([['equation',t('公式')],['table',t('表格')],['figure',t('图像 + 图注')],['algorithm',t('算法')],['ocr',t('仅提取文字')]] as [string,string][]).map(([val,lbl]) => (
                    <div key={val} className={`ios-dropdown-item ${visionMode === val ? 'active' : ''}`} onClick={() => { setVisionMode(val as 'equation'|'table'|'figure'|'algorithm'|'ocr'); setVisionResult(''); setVisionModeDropdownOpen(false); }}>
                      {lbl}
                      {visionMode === val && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="field">
            <label>{t('上传图片')}</label>
            <div
              className={`image-drop-zone ${visionFile ? 'has-file' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('drag-over'); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('drag-over');
                const file = e.dataTransfer.files?.[0];
                if (file && file.type.startsWith('image/')) {
                  setVisionFile(file);
                  setVisionResult('');
                }
              }}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                for (const item of items) {
                  if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                      setVisionFile(file);
                      setVisionResult('');
                    }
                    break;
                  }
                }
              }}
              tabIndex={0}
            >
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setVisionFile(file);
                  setVisionResult('');
                }}
                style={{ display: 'none' }}
                id="vision-file-input"
              />
              {visionFile ? (
                <div className="drop-zone-preview">
                  <span className="file-name">{visionFile.name}</span>
                  <button className="remove-btn" onClick={(e) => { e.stopPropagation(); setVisionFile(null); setVisionPreviewUrl(''); }}>✕</button>
                </div>
              ) : (
                <label htmlFor="vision-file-input" className="drop-zone-content">
                  <span className="drop-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span>
                  <span className="drop-text">{t('点击选择、拖拽或粘贴图片')}</span>
                </label>
              )}
            </div>
          </div>
          {visionPreviewUrl && (
            <div className="vision-preview">
              <img src={visionPreviewUrl} alt="preview" />
            </div>
          )}
          <div className="field">
            <label>{t('附加约束 (可选)')}</label>
            <textarea
              className="input"
              value={visionPrompt}
              onChange={(event) => setVisionPrompt(event.target.value)}
              placeholder={t('例如：只输出 tabular，不要表格标题')}
              rows={2}
            />
          </div>
          <div className="vision-actions">
            <button className="ios-btn secondary" onClick={handleVisionSubmit} disabled={visionBusy}>
              {visionBusy ? t('识别中...') : t('开始识别')}
            </button>
            <button className="ios-btn primary" onClick={handleVisionInsert} disabled={!visionResult}>{t('插入到光标')}</button>
          </div>
          {visionResult && (
            <div className="vision-result">
              <div className="muted">{t('识别结果 (可编辑)：')}</div>
              <textarea
                className="input"
                value={visionResult}
                onChange={(event) => setVisionResult(event.target.value)}
                rows={6}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
