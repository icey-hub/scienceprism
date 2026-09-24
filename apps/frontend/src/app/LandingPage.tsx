import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock3, FilePlus2, FolderOpen, Import, Languages, Search, Settings2, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listProjects, type ProjectMeta } from '../api/projectAdapter';
import './landing/start-workspace.css';

function formatUpdatedAt(project: ProjectMeta, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(project.updatedAt || project.createdAt));
}

export default function LandingPage() {
  const navigate = useNavigate();
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
    <main className="start-workspace">
      <aside className="start-workspace-sidebar">
        <button className="start-workspace-brand" onClick={() => navigate('/')} type="button"><span>S</span><strong>SciencePrism</strong></button>
        <nav aria-label={t('工作区导航')}>
          <button className="is-active" type="button"><Clock3 size={17} />{t('快速开始')}</button>
          <button onClick={() => navigate('/projects')} type="button"><FolderOpen size={17} />{t('所有项目')}</button>
        </nav>
        <div className="start-workspace-sidebar-footer">
          <button onClick={() => navigate('/projects?action=settings')} type="button"><Settings2 size={17} />{t('模型设置')}</button>
          <button onClick={switchLanguage} type="button"><Languages size={17} />{i18n.language === 'en-US' ? '中文' : 'English'}</button>
        </div>
      </aside>

      <section className="start-workspace-main">
        <header className="start-workspace-heading">
          <div><span>WORKSPACE</span><h1>{t('快速开始')}</h1><p>{t('继续最近的文稿，或开启一项新的研究。')}</p></div>
          <button onClick={() => navigate('/projects?action=create')} type="button"><FilePlus2 size={17} />{t('新建项目')}</button>
        </header>

        <div className="start-workspace-actions" aria-label={t('开始方式')}>
          <button onClick={() => navigate('/projects?action=create')} type="button"><FilePlus2 size={19} /><span><strong>{t('空白项目')}</strong><small>{t('从研究问题开始')}</small></span><ArrowRight size={16} /></button>
          <button onClick={() => navigate('/projects?action=templates')} type="button"><Sparkles size={19} /><span><strong>{t('论文模板')}</strong><small>ACL · CVPR · ICML</small></span><ArrowRight size={16} /></button>
          <button onClick={() => navigate('/projects?action=import')} type="button"><Import size={19} /><span><strong>{t('导入')}</strong><small>Zip · arXiv</small></span><ArrowRight size={16} /></button>
        </div>

        <section className="start-library" aria-labelledby="recent-documents-title">
          <div className="start-library-toolbar">
            <div><Clock3 size={16} /><h2 id="recent-documents-title">{query ? t('搜索结果') : t('最近文稿')}</h2><span>{visibleProjects.length}</span></div>
            <label><Search size={16} /><input type="search" aria-label={t('搜索项目、问题或标签')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索项目、问题或标签')} /></label>
          </div>

          {error ? <div className="start-library-empty" role="alert"><strong>{error}</strong><button className="btn ghost" onClick={load}>{t('重试')}</button></div> : loading ? <div className="start-library-empty" role="status">{t('正在读取项目…')}</div> : visibleProjects.length ? (
            <div className="start-document-grid">
              {visibleProjects.map((project) => (
                <button className="start-document" key={project.id} onClick={() => navigate(`/project/${project.id}`)} type="button">
                  <span className="start-paper-preview"><span className="paper-category">{t('研究项目')}</span><strong>{project.name}</strong><span className="paper-summary">{project.researchQuestion || t('尚未填写研究问题')}</span>{project.tags?.length ? <span className="paper-tags">{project.tags.slice(0, 3).join(' · ')}</span> : null}</span>
                  <span className="start-document-copy"><time>{formatUpdatedAt(project, i18n.language)}</time></span>
                </button>
              ))}
            </div>
          ) : (
            <div className="start-library-empty"><strong>{query ? t('没有匹配的项目') : t('还没有项目')}</strong><span>{query ? t('试试项目名称、研究问题或标签。') : t('从上方任一种方式开始。')}</span></div>
          )}
          {!query && projects.length > visibleProjects.length && <button className="start-library-more" onClick={() => navigate('/projects')} type="button">{t('查看所有项目')}<ArrowRight size={14} /></button>}
        </section>
      </section>
    </main>
  );
}
