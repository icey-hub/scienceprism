import { useEffect } from 'react';
import { useWebsearch } from '../editor/useWebsearch';
import { appendLog } from '../editor/modelText';
import { workspaceModel } from './workspaceModel';
import { mergeBibEntries } from './projectDocuments';
import type { useProjectDocuments } from './useProjectDocuments';
export function useWebsearchTool(docs:ReturnType<typeof useProjectDocuments>) {
 const controller=useWebsearch(workspaceModel('search'));
 const {websearchTargetFile,websearchTargetBib,setWebsearchTargetFile,setWebsearchTargetBib,setWebsearchLog}=controller;
 useEffect(()=>{if(!websearchTargetFile&&docs.path)setWebsearchTargetFile(docs.path);},[websearchTargetFile,docs.path,setWebsearchTargetFile]);
 useEffect(()=>{if(!websearchTargetBib&&docs.bibFiles.length)setWebsearchTargetBib(docs.bibFiles[0]);},[websearchTargetBib,docs.bibFiles,setWebsearchTargetBib]);
 const applyWebsearchInsert=async()=>{
  try {
   const selected=controller.websearchResults.filter(item=>controller.websearchSelected[item.id]);
   if(!selected.length)throw new Error('请选择至少一条结果。');
   if(!(websearchTargetFile||docs.path))throw new Error('请选择目标 TeX 文件。');
   const target=websearchTargetBib||await docs.createBib();setWebsearchTargetBib(target);
   const notes=selected.map(item=>`  \\item ${controller.websearchItemNotes[item.id]||item.summary||item.title}${item.citeKey?` \\cite{${item.citeKey}}`:''}`);
   const block=`\\paragraph{逐条总结}\n\\begin{itemize}\n${notes.join('\n')}\n\\end{itemize}\n${controller.websearchParagraph?`\n\\paragraph{综合总结}\n${controller.websearchParagraph}\n`:''}`;
   await docs.perform(async()=>{
    await docs.update(target,content=>mergeBibEntries(content,selected.map(item=>item.bibtex).filter(Boolean)).content);
    appendLog(setWebsearchLog,`Bib 已保存：${target}`);
    await docs.append(block,websearchTargetFile||docs.path);
   });
   appendLog(setWebsearchLog,`总结已保存：${websearchTargetFile||docs.path}`);
  }catch(cause){docs.report(cause);appendLog(setWebsearchLog,String(cause));}
 };
 return {controller:{...controller,websearchBusy:controller.websearchBusy||docs.busy},applyWebsearchInsert,insertAtCursor:(text:string)=>docs.insert(text,websearchTargetFile||docs.path)};
}
