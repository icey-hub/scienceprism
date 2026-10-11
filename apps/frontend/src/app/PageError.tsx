import { useRouteError } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isPageResourceError, pageErrorMessage } from './pageLoadError';
import './PageError.css';

export default function PageError() {
  const error = useRouteError(), { t } = useTranslation();
  const resourceError = isPageResourceError(error);
  return <main className="page-error" role="alert">
    <h1>{t(resourceError ? '页面资源未能加载' : '页面暂时无法打开')}</h1>
    <p>{t(resourceError ? '页面可能刚更新了版本，或网络连接暂时中断。重新加载后可继续打开当前页面。' : '请重新加载当前页面；如果仍有问题，可返回项目列表。')}</p>
    <div className="page-error-actions"><button type="button" onClick={() => window.location.reload()}>{t('重新加载页面')}</button><a href="/projects">{t('返回项目列表')}</a></div>
    {pageErrorMessage(error) && <details><summary>{t('错误详情')}</summary><pre>{pageErrorMessage(error)}</pre></details>}
  </main>;
}
