import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listDatasets, type DatasetVersion } from '../../../api/datasetAdapter';

export function DatasetVersionPicker({ projectId, value, disabled, onChange }: {
  projectId: string; value: string; disabled?: boolean;
  onChange: (id: string, sha256: string) => void;
}) {
  const [datasets, setDatasets] = useState<DatasetVersion[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const lifetime = new AbortController(); setDatasets([]); setError(''); setLoading(true);
    listDatasets(projectId, lifetime.signal).then(result => {
      if (!lifetime.signal.aborted) setDatasets(result.datasets);
    }).catch(cause => {
      if (!lifetime.signal.aborted) setError(cause instanceof Error ? cause.message : '数据版本暂时不可读取。');
    }).finally(() => { if (!lifetime.signal.aborted) setLoading(false); });
    return () => lifetime.abort();
  }, [projectId]);
  return <div className="research-field research-field-wide">
    <label><span>使用已取得的数据版本</span><select aria-label="选择实验数据版本" disabled={disabled || loading} value={datasets.some(dataset => dataset.id === value) ? value : ''} onChange={event => {
      const dataset = datasets.find(item => item.id === event.target.value);
      if (dataset) onChange(dataset.id, dataset.sha256);
    }}><option value="">{loading ? '读取数据版本…' : '选择数据，同时固定 SHA256'}</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.byteLength.toLocaleString()} bytes · {dataset.sha256.slice(0, 12)}</option>)}</select></label>
    {error && <span role="alert">{error}</span>}
    <small>运行时准备独立输入副本，原始数据保持不变。<Link to={`/project/${encodeURIComponent(projectId)}/lab/data`}>查看或取得数据</Link></small>
  </div>;
}
