const DICT = {
  'zh-CN': {
    llm_error: 'LLM 未配置或调用失败：{{error}}。你可以在前端设置里填写 API Key/Endpoint，或配置 SCIENCEPRISM_LLM_* 环境变量。',
    missing_project_id_tools: '缺少 projectId，无法使用工具模式。',
    zip_extract_failed: 'Zip 解压失败: {{error}}',
    arxiv_download_failed: 'arXiv 下载失败: {{error}}'
  },
  'en-US': {
    llm_error: 'LLM is not configured or the call failed: {{error}}. You can set the API Key/Endpoint in the UI or configure SCIENCEPRISM_LLM_* environment variables.',
    missing_project_id_tools: 'Missing projectId; tools mode is unavailable.',
    zip_extract_failed: 'Zip extraction failed: {{error}}',
    arxiv_download_failed: 'arXiv download failed: {{error}}'
  }
};

export function getLang(req) {
  const header = req?.headers?.['x-lang'] || req?.headers?.['accept-language'] || '';
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === 'string' && raw.toLowerCase().includes('en')) {
    return 'en-US';
  }
  return 'zh-CN';
}

export function t(lang, key, params = {}) {
  const bucket = DICT[lang] || DICT['zh-CN'];
  const template = bucket[key] || DICT['zh-CN'][key] || key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, token) => {
    const value = params[token];
    return value === undefined || value === null ? '' : String(value);
  });
}
