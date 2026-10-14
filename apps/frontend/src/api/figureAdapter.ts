import { request, type ValidationCampaignFigure, type ValidationCampaignFigureStyle } from './client';

export type FigureStyle = ValidationCampaignFigureStyle;
export type CampaignFigure = ValidationCampaignFigure & {kind:'campaign';parentFigureId?:string};
export type TableFigure = Omit<ValidationCampaignFigure,'campaignId'|'metricName'|'candidateVariantId'|'comparisonVariantId'|'statistics'> & {
  kind:'table';parentFigureId?:string;
  statistics:{dataRows:number;series:number;units:string|null;sampleSize:number|null;errorBars:'none';caption:string};
};
export type ProjectFigure = CampaignFigure | TableFigure;
export interface TableFigureSource {
  schemaVersion:1;kind:'table';projectId:string;tableLatex:string;sourceOrigin:'project-file'|'user-paste';sourcePath:string|null;sourceFileSha256:string|null;
  parsedTable:{headers:string[];rowLabels:string[];series:{name:string;values:number[]}[]};chartType:'bar'|'line'|'heatmap';layout:'single'|'panels';unit:string|null;sampleSize:number|null;
}
export type FigureSource = TableFigureSource | Record<string,unknown>;
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
export const figureFileUrl=(url:string)=>url.startsWith('/api/')?url:undefined;
