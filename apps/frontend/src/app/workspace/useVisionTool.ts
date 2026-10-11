import { useEffect, useRef, useState } from 'react';
import { visionToLatex } from '../../api/editorAdapter';
import { serialModelRequest } from '../editor/serialModelRequest';
import { workspaceModel } from './workspaceModel';
import type { useProjectDocuments } from './useProjectDocuments';
export function useVisionTool(docs:ReturnType<typeof useProjectDocuments>) {
 const [visionMode,setVisionMode]=useState<'equation'|'table'|'figure'|'algorithm'|'ocr'>('equation');
 const [visionFile,setVisionFile]=useState<File|null>(null),[visionPrompt,setVisionPrompt]=useState(''),[visionResult,setVisionResult]=useState('');
 const [visionBusy,setVisionBusy]=useState(false),[visionPreviewUrl,setVisionPreviewUrl]=useState('');const lock=useRef(false);
 useEffect(()=>{if(!visionFile){setVisionPreviewUrl('');return;}const url=URL.createObjectURL(visionFile);setVisionPreviewUrl(url);return()=>URL.revokeObjectURL(url);},[visionFile]);
 const handleVisionSubmit=async()=>{if(lock.current)return;if(!visionFile){docs.report('请先选择图片。');return;}lock.current=true;docs.clearFeedback();setVisionBusy(true);setVisionResult('');try{
  const defaults={table:'只输出表格的 LaTeX（tabular 或 table），不要包含文档结构。',algorithm:'只输出 algorithm/algorithmic 环境，不要包含文档结构。',equation:'只输出 equation 环境，不要包含文档结构。',figure:'',ocr:''};
  const result=await serialModelRequest(async()=>{if(!docs.alive.current)throw new Error('页面已关闭。');return visionToLatex({projectId:docs.projectId,file:visionFile,mode:visionMode,prompt:visionPrompt.trim()||defaults[visionMode],llmConfig:workspaceModel('vision')});});
  if(!result.ok)throw new Error(result.error||'识别失败');if(docs.alive.current)setVisionResult(result.latex||'');
 }catch(cause){docs.report(cause);}finally{lock.current=false;if(docs.alive.current)setVisionBusy(false);}};
 return {visionMode,setVisionMode,visionFile,setVisionFile,visionPrompt,setVisionPrompt,visionResult,setVisionResult,visionBusy,visionPreviewUrl,setVisionPreviewUrl,handleVisionSubmit,handleVisionInsert:()=>{void docs.insert(visionResult).catch(docs.report);}};
}
