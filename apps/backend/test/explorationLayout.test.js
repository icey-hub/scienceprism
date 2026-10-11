import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
// Use the existing frontend compiler, keeping the test runnable on Node 20 too.
const source = await readFile(new URL('../../frontend/src/app/project/explorationLayout.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 } }).outputText;
const { horizontalExplorationLayout, researchExecutionLayout } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const viewSource = await readFile(new URL('../../frontend/src/app/project/explorationView.ts', import.meta.url), 'utf8');
const viewCompiled = transpileModule(viewSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2020 } }).outputText;
const { normalizeExplorationView } = await import(`data:text/javascript;base64,${Buffer.from(viewCompiled).toString('base64')}`);

const nodes = (...ids) => ids.map(id => ({ id }));
const edge = (from, to) => ({ from, to });
test('execution dependencies extend rightwards even between tasks of the same kind', () => {
  const records = nodes('stage', 'parent', 'child', 'call', 'result');
  const links = [edge('stage', 'parent'), edge('parent', 'child'), edge('child', 'call'), edge('call', 'result')];
  const layout = horizontalExplorationLayout(records, links);
  for (const { from, to } of links) assert.ok(layout[to].x > layout[from].x, `${from} → ${to}`);
  assert.equal(new Set(Object.values(layout).map(point => point.y)).size, 1);
});
test('branching and joined runs retain every node and leave room for their cards', () => {
  const records = nodes('stage', 'left', 'right', 'joined', 'artifact');
  const links = [edge('stage', 'left'), edge('stage', 'right'), edge('left', 'joined'), edge('right', 'joined'), edge('joined', 'artifact')];
  const snapshot = JSON.stringify({ records, links });
  const layout = horizontalExplorationLayout(records, links);
  for (const { from, to } of links) assert.ok(layout[to].x > layout[from].x);
  assert.ok(Math.abs(layout.left.y - layout.right.y) >= 152);
  assert.equal(JSON.stringify({ records, links }), snapshot, 'layout must not change graph provenance');
  assert.deepEqual(horizontalExplorationLayout(records, links), layout);
});
test('cycles and self-references stay visible without removing recorded relationships', () => {
  const records = nodes('root', 'a', 'b', 'out', 'self');
  const links = [edge('root', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'out'), edge('self', 'self')];
  const layout = horizontalExplorationLayout(records, links);
  assert.equal(layout.a.x, layout.b.x);
  assert.ok(Math.abs(layout.a.y - layout.b.y) >= 152);
  assert.ok(layout.root.x < layout.a.x && layout.out.x > layout.b.x);
  assert.equal(Object.keys(layout).length, records.length);
  assert.equal(links.length, 5);
});
test('unrelated stages form a horizontal shelf without invented dependency edges', () => {
  const records = nodes('direction', 'search', 'selection', 'replication', 'ideation', 'method', 'experiment', 'writing');
  const layout = horizontalExplorationLayout(records, []);
  assert.equal(new Set(Object.values(layout).map(point => point.y)).size, 1);
  assert.ok(layout.writing.x > layout.direction.x);
  assert.equal(new Set(Object.values(layout).map(point => point.x)).size, 8);
});
test('multiple connected components and missing endpoints do not overlap', () => {
  const records = nodes('one', 'two', 'three', 'four', 'isolated');
  const layout = horizontalExplorationLayout(records, [edge('one', 'two'), edge('three', 'four'), edge('missing', 'one')]);
  assert.equal(new Set(Object.values(layout).map(point => `${point.x}:${point.y}`)).size, records.length);
  assert.ok(layout.one.y !== layout.three.y);
  assert.deepEqual(horizontalExplorationLayout([], [edge('missing', 'one')]), {});
});
test('the retained 1000-node limit can be laid out without recursive stack growth', () => {
  const records = Array.from({ length: 1000 }, (_, i) => ({ id: `run-${i}` }));
  const links = records.slice(1).map((node, i) => edge(records[i].id, node.id));
  const layout = horizontalExplorationLayout(records, links);
  assert.equal(Object.keys(layout).length, 1000);
  for (const { from, to } of links) assert.ok(layout[to].x > layout[from].x);
});
test('vertical caches migrate to recoverable snapshots while new manual positions persist', () => {
  const original = { positions: { run: { x: 300, y: 460 } }, viewport: { x: 12, y: -20, zoom: 0.8 }, collapsed: ['run'] };
  const migrated = normalizeExplorationView(original);
  assert.deepEqual(migrated.positions, {});
  assert.equal(migrated.viewport, undefined);
  assert.deepEqual(migrated.previousPositions, original.positions);
  assert.deepEqual(migrated.previousViewport, original.viewport);
  const saved = { ...migrated, positions: { run: { x: 470, y: 80 } }, viewport: { x: -55, y: 44, zoom: 1.2 } };
  assert.deepEqual(normalizeExplorationView(saved), saved);
  assert.deepEqual(original.positions.run, { x: 300, y: 460 });
});
test('malformed cached positions and viewport cannot corrupt the graph', () => {
  const view = normalizeExplorationView({version:2,positions:{bad:{x:'20',y:0},null:null,good:{x:0,y:0}},viewport:{x:0,y:0,zoom:Infinity},collapsed:[3,'run']});
  assert.deepEqual(view.positions, {good:{x:0,y:0}});
  assert.deepEqual(view.collapsed, ['run']);
  assert.equal(view.viewport, undefined);
  assert.deepEqual(normalizeExplorationView(null).positions, {});
});

test('eight stages stay on one horizontal spine and their execution strips do not overlap',()=>{
 const stages=['direction','search','selection','replication','ideation','method','experiment','writing'];
 const records=nodes(...stages.map(id=>`stage:${id}`),'run-a','call-a','artifact-a','run-b','artifact-b','loose');
 const links=[edge('stage:direction','run-a'),edge('run-a','call-a'),edge('call-a','artifact-a'),edge('stage:experiment','run-b'),edge('run-b','artifact-b')];
 const layout=researchExecutionLayout(records,links,stages);
 assert.equal(new Set(stages.map(id=>layout[`stage:${id}`].y)).size,1);
 for(let i=1;i<stages.length;i++)assert.ok(layout[`stage:${stages[i]}`].x>layout[`stage:${stages[i-1]}`].x);
 assert.equal(layout['run-a'].x,layout['stage:direction'].x);assert.ok(layout['run-a'].y>layout['stage:direction'].y+120);
 assert.ok(layout['call-a'].x>layout['run-a'].x && layout['artifact-a'].x>layout['call-a'].x);
 assert.ok(layout['artifact-a'].x+240<layout['stage:search'].x);
 assert.ok(layout.loose.y>layout['run-b'].y+120);
 assert.equal(new Set(Object.values(layout).map(point=>`${point.x}:${point.y}`)).size,records.length);
});
test('shared or cyclic execution stays present and partial stage queries do not invent missing phases',()=>{
 const records=nodes('stage:direction','stage:experiment','a','b','shared');
 const links=[edge('stage:direction','a'),edge('a','b'),edge('b','a'),edge('b','shared'),edge('stage:experiment','shared')];
 const snapshot=JSON.stringify(links),layout=researchExecutionLayout(records,links,['direction','search','experiment']);
 assert.equal(Object.keys(layout).length,records.length);assert.equal(layout['stage:search'],undefined);
 assert.equal(new Set(Object.values(layout).map(point=>`${point.x}:${point.y}`)).size,records.length);
 assert.equal(JSON.stringify(links),snapshot);
 assert.deepEqual(researchExecutionLayout(nodes('run'),[],[]),horizontalExplorationLayout(nodes('run'),[]));
});
