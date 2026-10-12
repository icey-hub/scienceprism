import { Link, useParams } from 'react-router-dom';
import { formatResearchDate, type ResearchDirection, type SearchRunSummary } from '../researchStages';

export interface SearchStageProps {
  direction: Pick<ResearchDirection, 'question' | 'keywords' | 'scope'>;
  value: SearchRunSummary;
  busy?: boolean;
  onQueryChange: (query: string) => void;
  onRunSearch: () => void;
}

export function SearchStage({ direction, value, busy = false, onQueryChange, onRunSearch }: SearchStageProps) {
  const { projectId = '' } = useParams();
  const canSearch = Boolean(value.query.trim() || direction.question.trim());

  return (
    <div className="research-page-stack">
      <section className="research-panel">
        <div className="research-panel-heading">
          <div>
            <span className="research-overline">AI SEARCH BUILDER</span>
            <h3>让 Harness 补充检索策略</h3>
          </div>
          <span className="research-status-note">按项目确认策略推进</span>
        </div>
        <div className="research-search-builder">
          <label className="research-field">
            <span>检索式</span>
            <input value={value.query} placeholder="留空则由 AI 根据研究方向生成" onChange={(event) => onQueryChange(event.target.value)} />
          </label>
          <button className="research-button research-button-primary" disabled={busy || !canSearch} onClick={onRunSearch} type="button">运行检索</button>
        </div>
        <div className="research-direction-trace">
          <span>人的方向</span>
          <strong>{direction.question || '尚未填写研究问题'}</strong>
          <span aria-hidden="true">&rarr;</span>
          <span>AI 补充检索式与来源</span>
        </div>
      </section>

      <section className="research-summary-grid" aria-label="检索摘要">
        <div><strong>{value.candidateCount}</strong><span>候选论文</span></div>
        <div><strong>{value.selectedCount}</strong><span>已选论文</span></div>
        <div><strong>{formatResearchDate(value.lastRunAt)}</strong><span>上次运行</span></div>
      </section>

      <section className="research-panel research-search-record" aria-label="已保存的检索记录">
        <div className="research-panel-heading"><h3>已保存的检索记录</h3></div>
        <p>以下是上次检索保存的内容；修改上方输入只用于下一次检索。</p>
        <div className="research-tag-list">{value.searchSessionIds?.map((id, index) => <Link key={id} to={`/project/${encodeURIComponent(projectId)}/papers/search?search=${encodeURIComponent(id)}`}>打开检索结果 {index + 1}</Link>)}<Link to={`/project/${encodeURIComponent(projectId)}/papers/search`}>独立论文搜索</Link></div>
        <h4>实际执行的检索式</h4>
        {value.queries?.length ? <ul>{value.queries.map((query, index) => <li key={index}>{query}</li>)}</ul> : <p>未记录检索式；旧记录不推断为已执行查询。</p>}
        <dl>
          <dt>请求来源</dt><dd>{value.requestedSources?.join('、') || '未记录'}</dd>
          <dt>实际尝试的来源</dt><dd>{value.sources?.join('、') || '未记录'}</dd>
        </dl>
        <details>
          <summary>AI 建议的检索标准与理由</summary>
          <p>这些是检索建议；筛选和阶段推进按项目自动化设置执行，科研核验状态另行记录。</p>
          <h4>建议纳入标准</h4>
          {value.inclusionCriteria?.length ? <ul>{value.inclusionCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p>未记录</p>}
          <h4>建议排除标准</h4>
          {value.exclusionCriteria?.length ? <ul>{value.exclusionCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p>未记录</p>}
          <h4>策略理由</h4><p>{value.strategyRationale || '未记录'}</p>
        </details>
      </section>

      <section className="research-callout">
        <strong>来源与质量分离</strong>
        <p>检索会保存来源和原始元数据。CCF 等级、出版物类型与同行评审等硬约束会在下一阶段由服务端执行。</p>
        {value.sources && value.sources.length > 0 && <div className="research-tag-list">{value.sources.map((source) => <span key={source}>{source}</span>)}</div>}
      </section>
    </div>
  );
}
