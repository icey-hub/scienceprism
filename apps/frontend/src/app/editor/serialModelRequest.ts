let tail: Promise<unknown> = Promise.resolve();
// These tools share one browser queue. A stopped search waits for its current
// response and never launches its subsequent steps; no parallel replacement call.
export function serialModelRequest<T>(work:()=>Promise<T>):Promise<T>{
 const result=tail.catch(()=>{}).then(work);
 tail=result.catch(()=>{});
 return result;
}
