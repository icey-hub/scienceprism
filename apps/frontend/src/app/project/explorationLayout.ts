type LayoutNode = { id: string };
type LayoutEdge = { from: string; to: string };
export type GraphPoint = { x: number; y: number };
const COLUMN = 336;
const ROW = 152;

/** Presentation only: condense cycles, then place actual dependencies left to right.
 * Disconnected records share a horizontal shelf; no synthetic edges are added. */
export function horizontalExplorationLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Record<string, GraphPoint> {
  const ids = nodes.map(node => node.id);
  const outgoing = new Map(ids.map(id => [id, new Set<string>()]));
  const incoming = new Map(ids.map(id => [id, new Set<string>()]));
  for (const { from, to } of edges) {
    if (!outgoing.has(from) || !outgoing.has(to)) continue;
    outgoing.get(from)!.add(to); incoming.get(to)!.add(from);
  }
  // Iterative finishing traversal avoids stack growth on long retained chains.
  const visited = new Set<string>(), finished: string[] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    const stack: [string, boolean][] = [[id, false]];
    while (stack.length) {
      const [current, exit] = stack.pop()!;
      if (exit) { finished.push(current); continue; }
      if (visited.has(current)) continue;
      visited.add(current); stack.push([current, true]);
      for (const child of [...outgoing.get(current)!].reverse()) if (!visited.has(child)) stack.push([child, false]);
    }
  }
  const groups: string[][] = [], membership = new Map<string, number>();
  for (const id of finished.reverse()) {
    if (membership.has(id)) continue;
    const group: string[] = [], stack = [id], index = groups.length;
    membership.set(id, index);
    while (stack.length) {
      const current = stack.pop()!; group.push(current);
      for (const parent of incoming.get(current)!) if (!membership.has(parent)) { membership.set(parent, index); stack.push(parent); }
    }
    groups.push(group);
  }
  const next = groups.map(() => new Set<number>()), previous = groups.map(() => new Set<number>());
  for (const id of ids) for (const child of outgoing.get(id)!) {
    const from = membership.get(id)!, to = membership.get(child)!;
    if (from !== to) { next[from].add(to); previous[to].add(from); }
  }
  const indegree = previous.map(parents => parents.size), depth = groups.map(() => 0);
  const queue = groups.map((_, i) => i).filter(i => !indegree[i]);
  for (let i = 0; i < queue.length; i++) for (const child of next[queue[i]]) {
    depth[child] = Math.max(depth[child], depth[queue[i]] + 1);
    if (--indegree[child] === 0) queue.push(child);
  }
  const result: Record<string, GraphPoint> = {}, placed = new Set<number>(), isolated: string[] = [];
  let offset = 0;
  for (const id of ids) {
    const first = membership.get(id)!;
    if (placed.has(first)) continue;
    if (!next[first].size && !previous[first].size && groups[first].length === 1) { placed.add(first); isolated.push(id); continue; }
    // Keep each unrelated execution branch together, even when it has multiple roots.
    const component = new Set<number>([first]), stack = [first];
    while (stack.length) {
      const current = stack.pop()!;
      for (const neighbor of [...next[current], ...previous[current]]) {
        if (!component.has(neighbor)) { component.add(neighbor); stack.push(neighbor); }
      }
    }
    const ordered = queue.filter(index => component.has(index)), center = new Map<number, number>();
    let leafRow = 0;
    for (const index of ordered.filter(index => !next[index].size)) {
      center.set(index, leafRow + (groups[index].length - 1) / 2); leafRow += groups[index].length;
    }
    let bottom = 0;
    for (const column of [...new Set(ordered.map(index => depth[index]))].sort((a,b)=>b-a)) {
      const columnGroups = ordered.filter(index => depth[index] === column);
      for (const index of columnGroups) if (next[index].size) {
        const children = [...next[index]].map(child => center.get(child)!);
        center.set(index, children.reduce((sum, row) => sum + row, 0) / children.length);
      }
      columnGroups.sort((a, b) => center.get(a)! - center.get(b)!);
      let last = -1;
      for (const index of columnGroups) {
        const start = Math.max(0, center.get(index)! - (groups[index].length - 1) / 2, last + 1);
        center.set(index, start + (groups[index].length - 1) / 2);
        groups[index].forEach((nodeId, row) => { result[nodeId] = { x: column * COLUMN, y: offset + (start + row) * ROW }; });
        last = start + groups[index].length - 1; bottom = Math.max(bottom, last);
        placed.add(index);
      }
    }
    offset += (bottom + 2) * ROW;
  }
  isolated.forEach((id, column) => { result[id] = { x: column * COLUMN, y: offset }; });
  return result;
}

/** Stage spine above independent execution strips. Stage membership follows
 * stored edges; shared descendants keep one position and all their real edges. */
export function researchExecutionLayout(nodes: LayoutNode[], edges: LayoutEdge[], stageOrder: string[]): Record<string, GraphPoint> {
  const ids=new Set(nodes.map(node=>node.id));
  const stages=stageOrder.map(id=>`stage:${id}`).filter(id=>ids.has(id));
  if(!stages.length) return horizontalExplorationLayout(nodes,edges);
  const stageIds=new Set(stages),owner=new Map(stages.map(id=>[id,id]));
  const outgoing=new Map(nodes.map(node=>[node.id,[] as string[]]));
  for(const edge of edges) if(ids.has(edge.from) && ids.has(edge.to)) outgoing.get(edge.from)!.push(edge.to);
  const queue=[...stages];
  for(let i=0;i<queue.length;i++) for(const child of outgoing.get(queue[i])!) {
    if(stageIds.has(child) || owner.has(child)) continue;
    owner.set(child,owner.get(queue[i])!);queue.push(child);
  }
  const result:Record<string,GraphPoint>={};let cursor=0,bottom=0;
  for(const stage of stages) {
    const members=nodes.filter(node=>owner.get(node.id)===stage);
    const local=horizontalExplorationLayout(members,edges);
    result[stage]={x:cursor,y:0};
    const children=members.filter(node=>node.id!==stage);
    const firstColumn=children.length ? Math.min(...children.map(node=>local[node.id].x)) : COLUMN;
    const starts=new Map<number,number>();
    for(const node of children) starts.set(local[node.id].x,Math.min(starts.get(local[node.id].x) ?? Infinity,local[node.id].y));
    let width=COLUMN;
    for(const node of children) {
      const point=local[node.id];
      result[node.id]={x:cursor+point.x-firstColumn,y:ROW*1.5+point.y-starts.get(point.x)!};
      width=Math.max(width,point.x-firstColumn+COLUMN);bottom=Math.max(bottom,result[node.id].y);
    }
    cursor+=width;
  }
  const unrelated=nodes.filter(node=>!owner.has(node.id));
  const extra=horizontalExplorationLayout(unrelated,edges);
  for(const node of unrelated) result[node.id]={x:extra[node.id].x,y:extra[node.id].y+bottom+ROW*2};
  return result;
}
