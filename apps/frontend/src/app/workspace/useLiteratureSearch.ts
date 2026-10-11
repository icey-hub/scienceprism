import { useEffect, useRef, useState } from 'react';
import { arxivSearch, arxivBibtex, runAgent, type ArxivPaper } from '../../api/editorAdapter';
import { useAssistantRun } from '../editor/useAssistantRun';
import { extractJsonBlock, safeJsonParse } from '../editor/modelText';
import { serialModelRequest } from '../editor/serialModelRequest';
import { mergeBibEntries } from './projectDocuments';
import { workspaceModel } from './workspaceModel';
import type { useProjectDocuments } from './useProjectDocuments';

export function useLiteratureSearch(docs: ReturnType<typeof useProjectDocuments>) {
 const [arxivQuery,setArxivQuery]=useState(''),[arxivMaxResults,setArxivMaxResults]=useState(5),[arxivResults,setArxivResults]=useState<ArxivPaper[]>([]);
 const [arxivSelected,setArxivSelected]=useState<Record<string,boolean>>({}),[arxivBusy,setArxivBusy]=useState(false),[arxivStatus,setArxivStatus]=useState('');
 const [useLlmSearch,setUseLlmSearch]=useState(false),[llmSearchOutput,setLlmSearchOutput]=useState(''),[bibTarget,setBibTarget]=useState('');
 const [autoInsertCite,setAutoInsertCite]=useState(true),[autoInsertToMain,setAutoInsertToMain]=useState(false),[citeTargetFile,setCiteTargetFile]=useState('');
 const [cache,setCache]=useState<Record<string,string>>({});
 const assistant=useAssistantRun(docs.projectId),lock=useRef(false);
 useEffect(()=>{if(!bibTarget&&docs.bibFiles.length)setBibTarget(docs.bibFiles[0]);},[docs.bibFiles,bibTarget]);
 const perform=async(work:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setArxivBusy(true);setArxivStatus('');try{await work();}catch(cause){if(docs.alive.current)setArxivStatus(String(cause));}finally{lock.current=false;if(docs.alive.current)setArxivBusy(false);}};
 const handleArxivSearch=()=>perform(async()=>{
  const query=arxivQuery.trim();if(!query)throw new Error('请输入检索关键词。');
  if(useLlmSearch){
   const res=await serialModelRequest(async()=>{if(!docs.alive.current)throw new Error('页面已关闭。');return runAgent({projectId:docs.projectId,task:'websearch',role:'paper-reviewer',prompt:`Search arXiv for the user query. Return at most ${arxivMaxResults} papers. Use arxiv_search and arxiv_bibtex tools. Return JSON ONLY: {"papers":[{"title":"","authors":[],"arxivId":"","bibtex":""}]}.`,selection:'',content:query,mode:'tools',activePath:docs.path,llmConfig:workspaceModel('search'),interaction:'agent',history:[]});});
   if(!docs.alive.current)return;if(!res.ok)throw new Error(res.reply||'检索失败');setLlmSearchOutput(res.reply||'');
   const parsed=safeJsonParse<{papers?:{title:string;authors?:string[];arxivId:string;bibtex?:string}[]}>(extractJsonBlock(res.reply||'')||'');
   if(!Array.isArray(parsed?.papers))throw new Error('LLM 输出无法解析为论文列表。');
   setArxivResults(parsed.papers.map(paper=>({title:paper.title,abstract:'',authors:paper.authors||[],arxivId:paper.arxivId,url:`https://arxiv.org/abs/${paper.arxivId}`})));
   setCache(Object.fromEntries(parsed.papers.filter(paper=>paper.bibtex).map(paper=>[paper.arxivId,paper.bibtex!])));
   if(!parsed.papers.length)setArxivStatus('没有匹配结果。');
  }else{
   const res=await arxivSearch({query,maxResults:arxivMaxResults});if(!docs.alive.current)return;if(!res.ok)throw new Error(res.error||'检索失败');setArxivResults(res.papers||[]);setCache({});if(!res.papers?.length)setArxivStatus('没有匹配结果。');
  }
  setArxivSelected({});
 });
 const handleArxivApply=()=>perform(async()=>{
  const selected=arxivResults.filter(paper=>arxivSelected[paper.arxivId]);if(!selected.length)throw new Error('请选择要导入的论文。');
  const entries:string[]=[];
  for(const paper of selected){const entry=cache[paper.arxivId]||(await arxivBibtex({arxivId:paper.arxivId})).bibtex;if(!docs.alive.current)return;if(!entry)throw new Error(`生成 BibTeX 失败：${paper.arxivId}`);entries.push(entry);}
  const target=bibTarget||await docs.createBib();setBibTarget(target);let keys:string[]=[];
  await docs.perform(()=>docs.update(target,content=>{const merged=mergeBibEntries(content,entries);keys=merged.keys;return merged.content;}));
  const file=citeTargetFile||docs.path;
  if(autoInsertToMain){
   if(!file)throw new Error('Bib 已保存。请选择引用插入文件。');
   const started=await assistant.start({task:'insert_citations',prompt:`Insert citations into ${file}. Use \\cite{${keys.join(',')}}. Keep edits minimal. Papers: ${JSON.stringify(selected.map(paper=>({title:paper.title,arxivId:paper.arxivId})))}`,permission:'edit',activePath:file,llmConfig:workspaceModel('search'),history:assistant.history},async()=>[{path:file,...(await docs.read(file)).version}]);
   if(!started)throw new Error(assistant.error||'Bib 已保存，引用任务未启动。');setArxivStatus('引用修改已提出，可到项目对话审阅。');
  }else if(autoInsertCite){await docs.insert(`\\cite{${keys.join(',')}}`,file);setArxivStatus('Bib 和引用已保存。');}
  else setArxivStatus('已写入 Bib。');
 });
 return {arxivQuery,setArxivQuery,arxivMaxResults,setArxivMaxResults,arxivResults,arxivSelected,arxivBusy,arxivStatus,useLlmSearch,setUseLlmSearch,llmSearchOutput,setLlmSearchOutput,bibTarget,setBibTarget,autoInsertCite,setAutoInsertCite,autoInsertToMain,setAutoInsertToMain,citeTargetFile:citeTargetFile||docs.path,setCiteTargetFile,handleArxivSearch,handleArxivApply,onSelectPaper:(id:string,selected:boolean)=>setArxivSelected(old=>({...old,[id]:selected})),assistant};
}
