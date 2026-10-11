import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
const dataDir = await mkdtemp(path.resolve('.cache/runtime-events-'));
process.env.SCIENCEPRISM_DATA_DIR = dataDir;
const { summarizeEvent, registerHarnessAdapter, runHarnessRequest, getHarnessRun } = await import('../src/services/harnessRuntime/index.js');
const { fakeHarnessAdapter } = await import('../src/services/harnessRuntime/adapters/fakeAdapter.js');
const { sumEventUsage } = await import('../src/services/harnessRuntime/runtimeEvents.js');
test.after(() => rm(dataDir, { recursive: true, force: true }));

test('raw SDK and already flat events preserve identities, content, usage and tool results', () => {
  const call = summarizeEvent({ params: { event: { type: 'tool/call', seq: 7, time: 1791676800000, data: { name: 'read_file', callId: 'sdk-call', arguments: '{"path":"main.tex","apiKey":"hidden"}' } } } });
  assert.equal(call.callId, 'sdk-call');
  assert.equal(call.name, 'read_file');
  assert.equal(call.sourceSequence, 7);
  assert.ok(!call.arguments.includes('hidden'));
  const flat = summarizeEvent({ type: 'assistant/message', text: 'flat output', usage: { inputTokens: 2, outputTokens: 3 } });
  assert.equal(flat.text, 'flat output');
  assert.equal(flat.usage.inputTokens, 2);
  const result = summarizeEvent({ type: 'tool/result', data: { message: { toolCallId: 'sdk-call', isError: true, content: [{ type: 'text', text: 'failed' }] }, error: { code: 'FIXTURE', reason: 'fixture failure' } } });
  assert.equal(result.callId, 'sdk-call');
  assert.equal(result.outcome, 'error');
  assert.equal(result.output, 'failed');
});

test('provider usage is summed across messages with disjoint SDK cache counters', () => {
  assert.deepEqual(sumEventUsage([
    { type: 'assistant/message', data: { usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, totalTokens: 9 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } } }
  ]), { inputTokens: 7, outputTokens: 9, cacheReadTokens: 4, cacheWriteTokens: 0, totalTokens: 20 });
  assert.equal(sumEventUsage([{ type: 'assistant/message', data: {} }]), null);
});

test('actual runtime persists stable bounded events and pairs terminal calls by attempt', async () => {
  const projectId = 'bounded';
  await mkdir(path.join(dataDir, projectId));
  await writeFile(path.join(dataDir, projectId, 'project.json'), '{}');
  registerHarnessAdapter({ ...fakeHarnessAdapter, async run({ emit }) {
    for (let index = 0; index < 1002; index++) emit({ type: 'adapter/tick', data: {} });
    emit({ type: 'tool/start', data: { name: 'read_file', callId: 'paired', arguments: '{"password":"private","path":"main.tex"}' } });
    emit({ type: 'tool/end', data: { callId: 'paired', output: 'x'.repeat(12000) } });
    return { finalResponse: 'fixture completed' };
  } });
  try {
    const result = await runHarnessRequest({ projectId, adapter: 'fake', task: 'fixture', capabilities: ['project.read'] });
    const run = await getHarnessRun(projectId, result.runId);
    assert.equal(run.events.length, 1000);
    assert.equal(run.eventRetention.total, 1004);
    assert.equal(run.eventRetention.dropped, 4);
    const terminal = run.events.at(-1);
    assert.equal(terminal.name, 'read_file');
    assert.equal(terminal.attempt, 1);
    assert.equal(terminal.runId, run.id);
    assert.equal(terminal.id, `${run.id}:1004`);
    assert.equal(terminal.truncated, true);
    assert.ok(terminal.output.length <= 8200);
    assert.ok(!JSON.stringify(run.events).includes('private'));
    assert.equal(new Set(run.events.map(event => event.id)).size, 1000);
  } finally { registerHarnessAdapter(fakeHarnessAdapter); }
});

test('DeepSeek adapter passes SDK notifications through the actual runtime without a second lossy summary', async () => {
  const projectId = 'sdk-notifications';
  const root = path.join(dataDir, projectId);
  await mkdir(root);
  await writeFile(path.join(root, 'project.json'), '{}');
  const sdkPath = path.join(dataDir, 'notification-sdk.mjs');
  await writeFile(sdkPath, `export class DeepSeekHarness {
    async run(_input, {onNotification}) {
      const events = [
        {type:'tool/call',seq:1,time:1791676800000,data:{name:'read_file',callId:'sdk-pair',arguments:'{"path":"main.tex"}'}},
        {type:'tool/result',seq:2,time:1791676800001,data:{message:{toolCallId:'sdk-pair',content:[{type:'text',text:'source bytes'}]}}},
        {type:'assistant/message',seq:3,time:1791676800002,data:{message:{content:[{type:'text',text:'answer'}]},usage:{inputTokens:2,outputTokens:3,totalTokens:5}}}
      ];
      for (const event of events) onNotification({method:'session.event',params:{event}});
      return {events,finalResponse:'answer',sessionId:'fixture-session'};
    }
    async close() {}
  }`);
  const previous = process.env.SCIENCEPRISM_HARNESS_SDK;
  process.env.SCIENCEPRISM_HARNESS_SDK = sdkPath;
  try {
    const result = await runHarnessRequest({projectId,adapter:'deepseek',fallback:false,task:'fixture',capabilities:['project.read'],llmConfig:{apiKey:'fixture-only-key',model:'fixture-only'}});
    const run = await getHarnessRun(projectId, result.runId);
    assert.equal(run.status,'completed');
    const call = run.events.find(event => event.type === 'tool/call');
    const returned = run.events.find(event => event.type === 'tool/result');
    const message = run.events.find(event => event.type === 'assistant/message');
    assert.equal(call.callId,'sdk-pair');
    assert.equal(returned.name,'read_file');
    assert.equal(returned.output,'source bytes');
    assert.equal(message.text,'answer');
    assert.equal(message.usage.inputTokens,2);
    assert.equal(run.tokenUsage.totalTokens,5);
    assert.equal(message.sourceSequence,3);
  } finally {
    if(previous === undefined) delete process.env.SCIENCEPRISM_HARNESS_SDK;
    else process.env.SCIENCEPRISM_HARNESS_SDK = previous;
  }
});
