import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { callLLM, type LLMConfig } from '../../api/editorAdapter';
import { appendLog, extractBibKey, extractJsonBlock, safeJsonParse } from './modelText';
import { serialModelRequest } from './serialModelRequest';
export interface WebsearchItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  bibtex: string;
  citeKey: string;
}

export function useWebsearch(searchLlmConfig:Partial<LLMConfig>) {
 const {t}=useTranslation();
 const running=useRef(false),stopped=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;stopped.current=true;};},[]);
 const ask=(payload:Parameters<typeof callLLM>[0])=>serialModelRequest(async()=>{
   if(stopped.current||!alive.current)throw new Error('Stopped');
   const result=await callLLM(payload);
   if(stopped.current||!alive.current)throw new Error('Stopped');
   return result;
 });
 const stopWebsearch=()=>{stopped.current=true;appendLog(setWebsearchLog,t('等待当前请求结束，停止后续步骤。'));};
  const [websearchQuery, setWebsearchQuery] = useState('');
  const [websearchLog, setWebsearchLog] = useState<string[]>([]);
  const [websearchBusy, setWebsearchBusy] = useState(false);
  const [websearchResults, setWebsearchResults] = useState<WebsearchItem[]>([]);
  const [websearchSelected, setWebsearchSelected] = useState<Record<string, boolean>>({});
  const [websearchParagraph, setWebsearchParagraph] = useState('');
  const [websearchItemNotes, setWebsearchItemNotes] = useState<Record<string, string>>({});
  const [websearchTargetFile, setWebsearchTargetFile] = useState('');
  const [websearchTargetBib, setWebsearchTargetBib] = useState('');
  const [websearchSelectedAll, setWebsearchSelectedAll] = useState(false);
  const runWebsearch = async () => {
    if (running.current) return;
    const query = websearchQuery.trim();
    if (!query) {
      setWebsearchLog([t('请输入查询关键词。')]);
      return;
    }
    running.current = true; stopped.current = false;
    setWebsearchBusy(true);
    setWebsearchLog([]);
    setWebsearchResults([]);
    setWebsearchSelected({});
    setWebsearchSelectedAll(false);
    setWebsearchParagraph('');
    setWebsearchItemNotes({});
    try {
      appendLog(setWebsearchLog, t('拆分查询...'));
      const splitRes = await ask({
        llmConfig: searchLlmConfig,
        messages: [
          { role: 'system', content: t('Split the query into 2-4 targeted search queries. Return JSON only: {"queries":["..."]}.') },
          { role: 'user', content: t('用户问题: {{query}}', { query }) }
        ]
      });
      if (!splitRes.ok || !splitRes.content) {
        throw new Error(splitRes.error || t('Query split failed'));
      }
      const jsonBlock = extractJsonBlock(splitRes.content);
      if (!jsonBlock) {
        throw new Error(t('无法解析拆分结果 JSON。'));
      }
      const parsed = safeJsonParse<{ queries?: string[] }>(jsonBlock);
      if (!parsed) {
        throw new Error(t('拆分结果 JSON 解析失败。'));
      }
      const queries = (parsed.queries || []).filter(Boolean).slice(0, 4);
      if (queries.length === 0) {
        throw new Error(t('拆分结果为空。'));
      }
      appendLog(setWebsearchLog, t('逐项检索: {{queries}}', { queries: queries.join(' | ') }));
      const aggregated: WebsearchItem[] = [];
      for (const [idx, q] of queries.entries()) {
          appendLog(setWebsearchLog, t('检索中: {{query}}', { query: q }));
          const res = await ask({
            llmConfig: searchLlmConfig,
            messages: [
              {
                role: 'system',
                content:
                  t('You are a search assistant. Use the provider search. Return JSON only: {"results":[{"title":"","summary":"","url":"","bibtex":""}]}.')
              },
              { role: 'user', content: t('帮我检索: {{query}}', { query: q }) }
            ]
          });
          if (!res.ok || !res.content) {
            appendLog(setWebsearchLog, t('检索失败: {{query}}', { query: q }));
            continue;
          }
          const block = extractJsonBlock(res.content);
          if (!block) {
            appendLog(setWebsearchLog, t('结果解析失败: {{query}}', { query: q }));
            continue;
          }
          const parsedRes = safeJsonParse<{ results?: { title?: string; summary?: string; url?: string; bibtex?: string }[] }>(block);
          if (!parsedRes) {
            appendLog(setWebsearchLog, t('结果 JSON 解析失败: {{query}}', { query: q }));
            continue;
          }
          const results = parsedRes.results || [];
          results.forEach((item, i) => {
            const bibtex = item.bibtex || '';
            const citeKey = bibtex ? extractBibKey(bibtex.replace(/\\n/g, '\n')) : '';
            aggregated.push({
              id: `${idx}-${i}-${item.url || item.title || 'result'}`,
              title: item.title || t('Untitled'),
              summary: item.summary || '',
              url: item.url || '',
              bibtex,
              citeKey
            });
          });
          appendLog(setWebsearchLog, t('完成: {{query}} ({{count}})', { query: q, count: results.length }));
      }
      const deduped: WebsearchItem[] = [];
      aggregated.forEach((item) => {
        if (!deduped.find((d) => d.url && item.url && d.url === item.url) && !deduped.find((d) => d.title === item.title)) {
          deduped.push(item);
        }
      });
      setWebsearchResults(deduped);
      appendLog(setWebsearchLog, t('聚合结果: {{count}} 条', { count: deduped.length }));
      if (deduped.length === 0) {
        setWebsearchBusy(false);
        return;
      }
      appendLog(setWebsearchLog, t('生成逐条总结...'));
      const summariesRes = await ask({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              t('你是论文检索助手。请为每篇论文写一条简短总结（1-2 句）。返回 JSON：{"summaries":[{"id":"","summary":""}]}.')
          },
          {
            role: 'user',
            content: JSON.stringify({
              papers: deduped.map((p) => ({
                id: p.id,
                title: p.title,
                summary: p.summary,
                url: p.url,
                citeKey: p.citeKey
              }))
            })
          }
        ]
      });
      if (summariesRes.ok && summariesRes.content) {
        const summaryBlock = extractJsonBlock(summariesRes.content);
        const parsedSummaries = summaryBlock
          ? safeJsonParse<{ summaries?: { id: string; summary: string }[] }>(summaryBlock)
          : null;
        if (parsedSummaries?.summaries?.length) {
          const notes: Record<string, string> = {};
          parsedSummaries.summaries.forEach((item) => {
            if (item.id && item.summary) {
              notes[item.id] = item.summary.trim();
            }
          });
          setWebsearchItemNotes(notes);
          appendLog(setWebsearchLog, t('逐条总结已生成。'));
        } else {
          appendLog(setWebsearchLog, t('逐条总结解析失败。'));
        }
      } else {
        appendLog(setWebsearchLog, t('逐条总结生成失败。'));
      }

      appendLog(setWebsearchLog, t('生成综合总结...'));
      const citeKeys = deduped.map((item) => item.citeKey).filter(Boolean);
      const paragraphRes = await ask({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              t('请根据提供论文生成 3-5 句中文综合总结（不要分条）。可以使用 \\cite{...} 引用。只返回总结文本。')
          },
          {
            role: 'user',
            content: JSON.stringify({ query, papers: deduped.map((p) => ({ title: p.title, summary: p.summary, url: p.url })), citeKeys })
          }
        ]
      });
      if (paragraphRes.ok && paragraphRes.content) {
        setWebsearchParagraph(paragraphRes.content.trim());
        appendLog(setWebsearchLog, t('段落已生成。'));
      } else {
        appendLog(setWebsearchLog, t('段落生成失败。'));
      }
    } catch (err) {
      if (alive.current) appendLog(setWebsearchLog, stopped.current ? t('后续步骤已停止。') : t('错误: {{error}}', { error: String(err) }));
    } finally {
      running.current = false;
      if (alive.current) setWebsearchBusy(false);
    }
  };

 return {websearchQuery,setWebsearchQuery,websearchLog,setWebsearchLog,websearchBusy,setWebsearchBusy,websearchResults,setWebsearchResults,websearchSelected,setWebsearchSelected,websearchParagraph,setWebsearchParagraph,websearchItemNotes,setWebsearchItemNotes,websearchTargetFile,setWebsearchTargetFile,websearchTargetBib,setWebsearchTargetBib,websearchSelectedAll,setWebsearchSelectedAll,runWebsearch,stopWebsearch};
}
