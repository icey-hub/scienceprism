import { useRef, useState } from 'react';
import { generateGptImage, plotFromTable } from '../../api/editorAdapter';
import { serialModelRequest } from '../editor/serialModelRequest';
import { workspaceModel } from './workspaceModel';
import type { useProjectDocuments } from './useProjectDocuments';
export function usePlotTool(docs:ReturnType<typeof useProjectDocuments>) {
 const [table,setTable]=useState('');
 const [plotType,setPlotType]=useState<'bar'|'line'|'heatmap'>('bar'),[plotTitle,setPlotTitle]=useState(''),[plotFilename,setPlotFilename]=useState(''),[plotPrompt,setPlotPrompt]=useState('');
 const [plotRetries,setPlotRetries]=useState(2),[plotAutoInsert,setPlotAutoInsert]=useState(false),[plotBusy,setPlotBusy]=useState(false),[plotStatus,setPlotStatus]=useState(''),[plotAssetPath,setPlotAssetPath]=useState('');
 const [imagePrompt,setImagePrompt]=useState(''),[imageSize,setImageSize]=useState<'1024x1024'|'1536x1024'|'1024x1536'>('1536x1024'),[imageQuality,setImageQuality]=useState<'low'|'medium'|'high'>('medium');
 const [imageBusy,setImageBusy]=useState(false),[imageStatus,setImageStatus]=useState(''),[imageAssetPath,setImageAssetPath]=useState('');const lock=useRef(false);
 const insertFigure=async(path:string)=>docs.insert(['\\begin{figure}[t]','\\centering',`\\includegraphics[width=0.9\\linewidth]{${path}}`,'\\caption{Caption.}',`\\label{fig:${path.replace(/[^a-zA-Z0-9]+/g,'-')}}`,'\\end{figure}'].join('\n'));
 const handlePlotGenerate=async()=>{
  if(lock.current)return;if(!/\\begin\s*\{(tabular|table)\}/.test(table)){setPlotStatus('请提供 LaTeX 表格（tabular）。');return;}
  lock.current=true;setPlotBusy(true);setPlotStatus('');try{
   const result=await serialModelRequest(async()=>{if(!docs.alive.current)throw new Error('页面已关闭。');return plotFromTable({projectId:docs.projectId,tableLatex:table,chartType:plotType,title:plotTitle.trim()||undefined,prompt:plotPrompt.trim()||undefined,filename:plotFilename.trim()||undefined,retries:plotRetries,llmConfig:workspaceModel()});});
   if(!docs.alive.current)return;if(!result.ok||!result.assetPath)throw new Error(result.error||'图表生成失败');setPlotAssetPath(result.assetPath);setPlotStatus('图表已生成');await docs.refresh();if(plotAutoInsert)await insertFigure(result.assetPath);
  }catch(cause){if(docs.alive.current)setPlotStatus(String(cause));}finally{lock.current=false;if(docs.alive.current)setPlotBusy(false);}
 };
 const handleGptImageGenerate=async()=>{
  if(lock.current||!imagePrompt.trim())return;lock.current=true;setImageBusy(true);setImageStatus('');try{
   const result=await serialModelRequest(async()=>{if(!docs.alive.current)throw new Error('页面已关闭。');return generateGptImage({projectId:docs.projectId,prompt:imagePrompt.trim(),size:imageSize,quality:imageQuality,llmConfig:workspaceModel()});});
   if(!docs.alive.current)return;if(!result.ok||!result.assetPath)throw new Error(result.error||'图像生成失败');setImageAssetPath(result.assetPath);setImageStatus('图像已生成');await docs.refresh();
  }catch(cause){if(docs.alive.current)setImageStatus(String(cause));}finally{lock.current=false;if(docs.alive.current)setImageBusy(false);}
 };
 return {projectId:docs.projectId,table,setTable,plotType,setPlotType,plotTitle,setPlotTitle,plotFilename,setPlotFilename,plotPrompt,setPlotPrompt,plotRetries,setPlotRetries,plotAutoInsert,setPlotAutoInsert,plotBusy,plotStatus,plotAssetPath,imagePrompt,setImagePrompt,imageSize,setImageSize,imageQuality,setImageQuality,imageBusy,imageStatus,imageAssetPath,handlePlotGenerate,handleGptImageGenerate,insertFigureSnippet:(path:string)=>{void insertFigure(path).catch(docs.report);}};
}
