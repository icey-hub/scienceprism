import type { Viewport } from '@xyflow/react';
import type { GraphPoint } from './explorationLayout';
export type SavedExplorationView = { version:2; viewport?:Viewport; collapsed:string[]; positions:Record<string,GraphPoint>; previousPositions?:Record<string,GraphPoint>; previousViewport?:Viewport };
function points(value:unknown):Record<string,GraphPoint> {
  if(!value || typeof value!=='object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([,point])=>point && Number.isFinite(point.x) && Number.isFinite(point.y)).map(([id,point])=>[id,{x:point.x,y:point.y}]));
}
function viewport(value:unknown):Viewport|undefined {
  if(!value || typeof value!=='object') return undefined;
  const point=value as Viewport;
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.zoom) && point.zoom>=0.1 && point.zoom<=2 ? {x:point.x,y:point.y,zoom:point.zoom} : undefined;
}
/** Old vertical positions remain available as a snapshot, never mistaken for
 * new automatic horizontal positions or silently discarded. */
export function normalizeExplorationView(value:unknown):SavedExplorationView {
  const data=value && typeof value==='object' ? value as Record<string,unknown> : {};
  const current=data.version===2;
  const previous=points(current ? data.previousPositions : data.positions);
  return {version:2,positions:current ? points(data.positions) : {},viewport:current ? viewport(data.viewport) : undefined,
    collapsed:Array.isArray(data.collapsed) ? data.collapsed.filter((id):id is string=>typeof id==='string') : [],
    previousPositions:Object.keys(previous).length ? previous : undefined,previousViewport:viewport(current ? data.previousViewport : data.viewport)};
}
