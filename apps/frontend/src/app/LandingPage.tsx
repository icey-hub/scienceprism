import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, Clock3, FilePlus2, FolderOpen, Import, Languages, Search, Settings2, Sparkles, Triangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listProjects, type ProjectMeta } from '../api/projectAdapter';
import BlueprintScene from './landing/PrismScene';
import './landing/start-workspace.css';

function formatUpdatedAt(project: ProjectMeta, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(project.updatedAt || project.createdAt));
}

export default function LandingPage() {
  const { t, i18n } = useTranslation();
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    void listProjects()
      .then((result) => setProjects((result.projects || []).filter((project) => !project.trashed)))
      .catch(() => setError(t('项目加载失败，请检查连接后重试。')))
      .finally(() => setLoading(false));
  }, [t]);
  useEffect(load, [load]);

  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const sorted = [...projects].sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
    if (!normalized) return sorted.slice(0, 8);
    return sorted.filter((project) => [project.name, project.researchQuestion, ...(project.tags || [])]
      .some((value) => value?.toLocaleLowerCase().includes(normalized)));
  }, [projects, query]);

  const switchLanguage = () => void i18n.changeLanguage(i18n.language === 'en-US' ? 'zh-CN' : 'en-US');

  return (
    <div className="start-workspace">
      <a className="start-skip-link" href="#recent-documents-title">{t('跳转到最近文稿')}</a>
      <header className="start-workspace-header">
        <Link className="start-workspace-brand" to="/" aria-label="SciencePrism">
          <span><Triangle size={19} strokeWidth={1.6} aria-hidden="true" /></span><strong>SciencePrism</strong>
        </Link>
        <nav className="start-workspace-nav" aria-label={t('工作区导航')}>
          <Link to="/" aria-current="page">{t('快速开始')}</Link>
          <Link to="/projects">{t('所有项目')}</Link>
        </nav>
        <div className="start-workspace-tools">
          <button onClick={switchLanguage} type="button" aria-label={t('切换语言')}><Languages size={17} aria-hidden="true" /><span>{i18n.language === 'en-US' ? '中文' : 'EN'}</span></button>
          <Link to="/projects?action=settings" aria-label={t('模型设置')} title={t('模型设置')}><Settings2 size={17} aria-hidden="true" /></Link>
        </div>
      </header>

      <main className="start-workspace-main">
        <section className="start-hero" aria-labelledby="start-title">
          <div className="start-hero-copy">
            <span className="start-eyebrow"><span />{t('你的研究，从这里展开')}</span>
            <h1 id="start-title">{t('让好奇心，')}<br /><span>{t('走得更远。')}</span></h1>
            <p>{t('从第一个问题，到下一篇论文。')}<br />{t('在一个专注的空间里，连接灵感、证据与表达。')}</p>
            <div className="start-hero-actions">
              <Link className="start-primary-action" to="/projects?action=create">{t('开启新研究')}<ArrowRight size={17} aria-hidden="true" /></Link>
              <a className="start-text-action" href="#recent-documents-title">{t('继续我的研究')}<ArrowUpRight size={16} aria-hidden="true" /></a>
            </div>
            <div className="start-hero-note"><BookOpen size={14} aria-hidden="true" />{t('研究、写作，思路始终相连。')}</div>
          </div>
          <BlueprintScene />
        </section>

        <nav className="start-workspace-actions" aria-label={t('开始方式')}>
          <Link to="/projects?action=create"><span className="start-action-icon"><FilePlus2 size={23} strokeWidth={1.5} aria-hidden="true" /></span><span><strong>{t('空白项目')}</strong><small>{t('从一个值得探索的问题开始')}</small></span><ArrowRight size={18} aria-hidden="true" /></Link>
          <Link to="/projects?action=templates"><span className="start-action-icon"><Sparkles size={23} strokeWidth={1.5} aria-hidden="true" /></span><span><strong>{t('论文模板')}</strong><small>{t('让想法，拥有合适的起点')}</small></span><ArrowRight size={18} aria-hidden="true" /></Link>
          <Link to="/projects?action=import"><span className="start-action-icon"><Import size={23} strokeWidth={1.5} aria-hidden="true" /></span><span><strong>{t('导入已有研究')}</strong><small>{t('从 Zip 或 arXiv 无缝继续')}</small></span><ArrowRight size={18} aria-hidden="true" /></Link>
        </nav>

        <section className="start-library" aria-labelledby="recent-documents-title">
          <div className="start-library-toolbar">
            <div className="start-library-heading"><span className="start-section-eyebrow">YOUR WORK, IN FOCUS</span><div><h2 id="recent-documents-title" tabIndex={-1}>{query.trim() ? t('搜索结果') : t('最近文稿')}</h2>{!loading && !error && <span className="start-project-count" aria-live="polite">{visibleProjects.length}</span>}</div></div>
            <label className="start-search"><Search size={17} aria-hidden="true" /><input type="search" aria-label={t('搜索项目、问题或标签')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索项目、问题或标签')} /></label>
          </div>

          {error ? (
            <div className="start-library-empty" role="alert"><strong>{error}</strong><button className="btn ghost" onClick={load} type="button">{t('重试')}</button></div>
          ) : loading ? (
            <div className="start-library-loading" role="status"><span className="start-loading-dot" />{t('正在读取项目…')}</div>
          ) : visibleProjects.length ? (
            <div className="start-document-grid">
              {visibleProjects.map((project, index) => (
                <Link className="start-document" key={project.id} to={`/project/${project.id}`}>
                  <div className="start-paper-preview">
                    <div className="start-paper-topline"><span className="paper-category">{t('研究项目')}</span><span className="paper-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span></div>
                    <h3>{project.name}</h3>
                    <p className="paper-summary">{project.researchQuestion || t('尚未填写研究问题')}</p>
                    {project.tags?.length ? <span className="paper-tags">{project.tags.slice(0, 3).join(' · ')}</span> : null}
                    <div className="start-paper-footer"><time dateTime={project.updatedAt || project.createdAt}><Clock3 size={12} aria-hidden="true" />{formatUpdatedAt(project, i18n.language)}</time><span className="start-document-open" aria-hidden="true"><ArrowRight size={16} /></span></div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="start-library-empty"><span className="start-empty-icon">{query.trim() ? <Search size={25} aria-hidden="true" /> : <FolderOpen size={25} aria-hidden="true" />}</span><strong>{query.trim() ? t('没有匹配的项目') : t('为下一个发现，留一页空白。')}</strong><span>{query.trim() ? t('试试项目名称、研究问题或标签。') : t('创建项目，让你的第一个想法在这里生长。')}</span>{!query.trim() && <Link className="start-text-action" to="/projects?action=create">{t('创建第一个项目')}<ArrowRight size={15} aria-hidden="true" /></Link>}</div>
          )}
          {!loading && !error && projects.length > 0 && <Link className="start-library-more" to="/projects">{t('查看所有项目')}<ArrowRight size={15} aria-hidden="true" /></Link>}
        </section>
        <footer className="start-workspace-footer"><span>SciencePrism</span><span>{t('为每一次认真探索而设计。')}</span></footer>
      </main>
    </div>
  );
}
