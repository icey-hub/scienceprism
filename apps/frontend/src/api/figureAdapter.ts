import { request, type ValidationCampaignFigure, type ValidationCampaignFigureStyle } from './client';

export type FigureStyle = ValidationCampaignFigureStyle;
export type FigureFile={path:string;sha256:string;bytes:number;url:string};
export type CampaignFigure = Omit<ValidationCampaignFigure,'files'> & {kind:'campaign';parentFigureId?:string;files:ValidationCampaignFigure['files']&{pptx?:FigureFile}};
export type TableFigure = Omit<ValidationCampaignFigure,'campaignId'|'metricName'|'candidateVariantId'|'comparisonVariantId'|'statistics'|'files'> & {
  kind:'table';parentFigureId?:string;
  files:ValidationCampaignFigure['files']&{pptx?:FigureFile};
  statistics:{dataRows:number;series:number;units:string|null;sampleSize:number|null;errorBars:'none';caption:string};
};
export interface NativeFigureSpec {
  schemaVersion:1;canvas:{widthPt:720;heightPt:540};
  nodes:{id:string;type:'text'|'rect'|'ellipse';x:number;y:number;width:number;height:number;text:string}[];
  edges:{id:string;from:string;to:string}[];
}
export interface DiagramFigure {
  id:string;kind:'diagram';familyId:string;parentFigureId?:string;createdAt:string;sourceSha256:string;styleSha256:string;style:FigureStyle;
  renderer:{name:string;version?:string;backend?:string;sha256?:string};statistics:{nodes:number;edges:number;caption:string};
  files:{svg:FigureFile;pptx:FigureFile;source:FigureFile;rendererSource:FigureFile;pdf?:FigureFile;png?:FigureFile};
}
export type ProjectFigure = CampaignFigure | TableFigure | DiagramFigure;
export interface TableFigureSource {
  schemaVersion:1;kind:'table';projectId:string;tableLatex:string;sourceOrigin:'project-file'|'user-paste';sourcePath:string|null;sourceFileSha256:string|null;
  parsedTable:{headers:string[];rowLabels:string[];series:{name:string;values:number[]}[]};chartType:'bar'|'line'|'heatmap';layout:'single'|'panels';unit:string|null;sampleSize:number|null;
}
export type FigureSource = TableFigureSource | Record<string,unknown>;
export interface NativeFigureSource {kind:'diagram';spec:NativeFigureSpec;}
export interface TableFigureInput {
  tableLatex:string;sourcePath?:string;chartType:'bar'|'line'|'heatmap';layout:'single'|'panels';style?:Partial<FigureStyle>;unit?:string;sampleSize?:number;
}
const base=(projectId:string)=>`/api/projects/${encodeURIComponent(projectId)}/figures`;
async function call<T>(url:string,options?:RequestInit):Promise<T> {
  try{return await request<T>(url,options);}
  catch(error){if(error instanceof Error){let body:unknown;try{body=JSON.parse(error.message);}catch{/* Preserve non-JSON transport errors. */}
    if(body&&typeof body==='object'&&'error' in body){const detail=(body as {error?:{message?:unknown}}).error?.message;if(typeof detail==='string')throw new Error(detail);}}
    throw error;}
}
export const listProjectFigures=(projectId:string,signal?:AbortSignal)=>call<{ok:boolean;figures:ProjectFigure[]}>(base(projectId),{signal});
export const getFigureSource=(projectId:string,figureId:string,signal?:AbortSignal)=>call<{ok:boolean;source:FigureSource}>(`${base(projectId)}/${encodeURIComponent(figureId)}/source`,{signal});
export const createTableFigure=(projectId:string,input:TableFigureInput,signal?:AbortSignal)=>call<{ok:boolean;figure:ProjectFigure;assetPath:string}>(`${base(projectId)}/from-table`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input),signal});
export const reviseFigureStyle=(projectId:string,figureId:string,style:FigureStyle,signal?:AbortSignal)=>call<{ok:boolean;figure:ProjectFigure}>(`${base(projectId)}/${encodeURIComponent(figureId)}/revisions`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify({style}),signal});
export const createNativeFigure=(projectId:string,input:{spec:NativeFigureSpec;style?:Partial<FigureStyle>;parentFigureId?:string},signal?:AbortSignal)=>call<{ok:boolean;figure:DiagramFigure}>(`${base(projectId)}/native`,{method:'POST',headers:{'x-scienceprism-actor':'human'},body:JSON.stringify(input),signal});
export const figureFileUrl=(url:string)=>url.startsWith('/api/')?url:undefined;
