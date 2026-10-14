import { useRef, useState } from 'react';
import { generateGptImage } from '../../api/editorAdapter';
import { serialModelRequest } from '../editor/serialModelRequest';
import { workspaceModel } from './workspaceModel';
import type { useProjectDocuments } from './useProjectDocuments';
export function useImageTool(docs:ReturnType<typeof useProjectDocuments>) {
 const [imagePrompt,setImagePrompt]=useState(''),[imageSize,setImageSize]=useState<'1024x1024'|'1536x1024'|'1024x1536'>('1536x1024'),[imageQuality,setImageQuality]=useState<'low'|'medium'|'high'>('medium');
 const [imageBusy,setImageBusy]=useState(false),[imageStatus,setImageStatus]=useState(''),[imageAssetPath,setImageAssetPath]=useState('');const lock=useRef(false);
 const insertFigure=async(path:string)=>docs.insert(['\\begin{figure}[t]','\\centering',`\\includegraphics[width=0.9\\linewidth]{${path}}`,'\\caption{Caption.}',`\\label{fig:${path.replace(/[^a-zA-Z0-9]+/g,'-')}}`,'\\end{figure}'].join('\n'));
 const handleGptImageGenerate=async()=>{
  if(lock.current||!imagePrompt.trim())return;lock.current=true;setImageBusy(true);setImageStatus('');try{
   const result=await serialModelRequest(async()=>{if(!docs.alive.current)throw new Error('页面已关闭。');return generateGptImage({projectId:docs.projectId,prompt:imagePrompt.trim(),size:imageSize,quality:imageQuality,llmConfig:workspaceModel()});});
   if(!docs.alive.current)return;if(!result.ok||!result.assetPath)throw new Error(result.error||'图像生成失败');setImageAssetPath(result.assetPath);setImageStatus('图像已生成');await docs.refresh();
  }catch(cause){if(docs.alive.current)setImageStatus(String(cause));}finally{lock.current=false;if(docs.alive.current)setImageBusy(false);}
 };
 return {projectId:docs.projectId,imagePrompt,setImagePrompt,imageSize,setImageSize,imageQuality,setImageQuality,imageBusy,imageStatus,imageAssetPath,handleGptImageGenerate,insertFigureSnippet:(path:string)=>{void insertFigure(path).catch(docs.report);}};
}
