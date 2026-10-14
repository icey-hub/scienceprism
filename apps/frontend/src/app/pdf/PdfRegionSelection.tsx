import { useRef, useState, type PointerEvent } from 'react';
import { pdfRegionFromDisplay, type PdfNormalizedRegion } from './pdfSelection';
export function PdfRegionSelection({page,rotation,onSelect,onExit}:{page:number;rotation:number;onSelect:(region:PdfNormalizedRegion,rotation:number)=>void;onExit:()=>void}) {
  const [draft,setDraft]=useState<PdfNormalizedRegion|null>(null),start=useRef<{x:number;y:number;pointerId:number}|null>(null);
  const point=(event:PointerEvent<HTMLDivElement>)=>{const bounds=event.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))};};
  const box=(event:PointerEvent<HTMLDivElement>)=>{const anchor=start.current;if(!anchor)return null;const end=point(event);return {x:Math.min(anchor.x,end.x),y:Math.min(anchor.y,end.y),width:Math.abs(anchor.x-end.x),height:Math.abs(anchor.y-end.y)};};
  return <div className="pdf-region-selection" role="button" tabIndex={0} aria-label={`框选第${page}页区域，Enter选择整页，Escape退出`} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onExit();}else if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();onSelect({x:0,y:0,width:1,height:1},rotation);}}}
    onPointerDown={event=>{if(event.button!==0||!event.isPrimary)return;event.preventDefault();event.stopPropagation();const location=point(event);start.current={...location,pointerId:event.pointerId};event.currentTarget.setPointerCapture(event.pointerId);setDraft({...location,width:0,height:0});}}
    onPointerMove={event=>{if(start.current?.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();setDraft(box(event));}}
    onPointerUp={event=>{if(start.current?.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();const rect=box(event),bounds=event.currentTarget.getBoundingClientRect();start.current=null;event.currentTarget.releasePointerCapture(event.pointerId);setDraft(null);if(rect&&rect.width*bounds.width>=3&&rect.height*bounds.height>=3)onSelect(pdfRegionFromDisplay(rect,rotation),rotation);}}
    onPointerCancel={()=>{start.current=null;setDraft(null);}}>
    {draft&&<span className="pdf-region-draft" style={{left:`${draft.x*100}%`,top:`${draft.y*100}%`,width:`${draft.width*100}%`,height:`${draft.height*100}%`}}/>}
  </div>;
}
