import { useState } from 'react';
export function ProjectDocumentTarget({paths,value,onChange,label='目标文稿'}:{paths:string[];value:string;onChange:(path:string)=>void;label?:string}) {
 const [open,setOpen]=useState(false);
 return <div className="workspace-document-target"><span>{label}</span><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{value || '项目上下文'} ▾</button>{open&&<div className="workspace-document-options"><button type="button" onClick={()=>{onChange('');setOpen(false);}}>项目上下文</button>{paths.map(path=><button key={path} onClick={()=>{onChange(path);setOpen(false);}}>{path}</button>)}</div>}</div>;
}
