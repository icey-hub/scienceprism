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
