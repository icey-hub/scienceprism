#!/usr/bin/env node
/**
 * Does chain-of-thought help a reasoning model, or does it only change the
 * answer format?
 *
 * Dataset
 * -------
 * GSM8K (Cobbe et al., 2021), the real test split, downloaded to
 * aidoc/datasets/gsm8k-test.jsonl. Questions are sampled deterministically so the
 * same seed gives the same subset.
 *
 * Why this is not a plain CoT replication
 * ---------------------------------------
 * The model under test is a reasoning model: it returns a hidden
 * `reasoning_content` alongside the visible reply. So there are two ways a
 * condition can look worse:
 *   1. the model reasoned to the wrong answer, or
 *   2. it reasoned to the right answer but the visible reply did not match the
 *      format the grader expects.
 * A single accuracy number cannot tell those apart. This experiment scores every
 * response under three extraction rules — the declared format, the last number
 * anywhere in the visible reply, and the last number in the hidden reasoning — so
 * the gap between them is measurable rather than assumed.
 *
 * Protocol
 * --------
 * Three conditions, temperature 0, one request at a time (U-20: the gateway is
 * shared, so calls are strictly serial). Every raw response is stored, so the
 * scoring can be re-derived without re-running the model.
 *
 * Usage:
 *   node scripts/experiment-cot-gsm8k.mjs [questions] [seed]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, loadDotEnv } from './lib/script-helpers.mjs';
import { assertExperimentArtifact } from './lib/experiment-artifacts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = path.join(REPO_ROOT, 'aidoc', 'datasets', 'gsm8k-test.jsonl');
const OUT = path.join(REPO_ROOT, 'aidoc', 'experiment-cot-gsm8k.json');

const COUNT = Number(process.argv[2]) || 200;
const SEED = process.argv[3] || 'gsm8k-cot-2026';

await loadDotEnv(REPO_ROOT);

const ENDPOINT = process.env.SCIENCEPRISM_LLM_ENDPOINT;
const API_KEY = process.env.SCIENCEPRISM_LLM_API_KEY;
const MODEL = process.env.SCIENCEPRISM_LLM_MODEL;

const CONDITIONS = [
  {
    id: 'direct',
    system: 'Solve the problem. Reply with only the final number, nothing else.'
  },
  {
    id: 'cot',
    system: 'Solve the problem. Think step by step, then end with a line exactly of the form: The answer is <number>.'
  },
  {
    id: 'format',
    system: 'Solve the problem. End your reply with exactly: #### <number>'
  }
];

function lastNumber(text) {
  const cleaned = String(text || '').replace(/,/g, '');
  const matches = [...cleaned.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => m[0]);
  return matches.length ? matches[matches.length - 1] : null;
}

function declaredAnswer(condition, content) {
  const text = String(content || '');
  if (condition === 'direct') {
    const match = text.trim().match(/^-?\d+(?:\.\d+)?$/);
    return match ? match[0] : null;
  }
  if (condition === 'cot') {
    const match = [...text.matchAll(/The answer is\s*(-?\d+(?:\.\d+)?)/gi)].pop();
    return match ? match[1] : null;
  }
  const match = [...text.matchAll(/####\s*(-?\d+(?:\.\d+)?)/g)].pop();
  return match ? match[1] : null;
}

const normalize = (value) => (value === null || value === undefined ? null : String(value).replace(/,/g, '').trim());

const rows = (await fs.readFile(DATASET, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const sampled = rows
  .map((row, index) => ({ row, index, key: hash(`${SEED}:${index}`) }))
  .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  .slice(0, COUNT)
  .map((entry) => entry.row);

console.log(`dataset : GSM8K test, ${rows.length} questions, sampled ${sampled.length} (seed ${SEED})`);
console.log(`model   : ${MODEL}`);
console.log(`design  : ${CONDITIONS.length} conditions x ${sampled.length} questions = ${CONDITIONS.length * sampled.length} serial calls\n`);

let previous = null;
try {
  previous = JSON.parse(await fs.readFile(OUT, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous && (previous.seed !== SEED || previous.sampledQuestions !== sampled.length || previous.model !== MODEL ||
  JSON.stringify(previous.conditions) !== JSON.stringify(CONDITIONS) || previous.records?.length !== CONDITIONS.length * sampled.length)) {
  throw new Error(`Existing artifact does not match this run; refusing to overwrite ${OUT}`);
}
const records = previous?.records ? [...previous.records] : [];
let done = 0;
for (const condition of CONDITIONS) {
  for (let index = 0; index < sampled.length; index += 1) {
    const existingIndex = records.findIndex((record) => record.condition === condition.id && record.index === index);
    if (existingIndex >= 0 && !records[existingIndex].error) continue;
    const item = sampled[index];
    const gold = normalize(item.answer.split('####').pop());
    const started = Date.now();
    let content = '';
    let reasoning = '';
    let usage = null;
    let error = null;

    try {
      const response = await fetch(`${ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          messages: [
            { role: 'system', content: condition.system },
            { role: 'user', content: item.question }
          ]
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const message = data?.choices?.[0]?.message || {};
      content = String(message.content || '');
      reasoning = String(message.reasoning_content || '');
      usage = data?.usage || null;
      if (!content.trim()) throw new Error('empty response content');
    } catch (caught) {
      error = String(caught?.message || caught).slice(0, 200);
    }

    const declared = normalize(declaredAnswer(condition.id, content));
    const lenient = normalize(lastNumber(content));
    const fromReasoning = normalize(lastNumber(reasoning));

    const record = {
      condition: condition.id,
      index,
      gold,
      declared,
      lenient,
      fromReasoning,
      declaredCorrect: declared !== null && declared === gold,
      lenientCorrect: lenient !== null && lenient === gold,
      reasoningCorrect: fromReasoning !== null && fromReasoning === gold,
      parseFailed: declared === null,
      seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      contentChars: content.length,
      reasoningChars: reasoning.length,
      completionTokens: usage?.completion_tokens ?? null,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      error,
      content,
      reasoning
    };
    if (error) {
      console.error(`  ${condition.id}#${index} failed: ${error}; original artifact retained`);
      process.exitCode = 1;
      continue;
    }
    if (existingIndex >= 0) records[existingIndex] = record;
    else records.push(record);

    done += 1;
    if (done % 25 === 0 || done === CONDITIONS.length * sampled.length) {
      console.log(`  ${String(done).padStart(4)}/${CONDITIONS.length * sampled.length}  ${condition.id.padEnd(7)} ${records.filter((r) => r.declaredCorrect).length} correct so far`);
    }
  }
}

if (process.exitCode) throw new Error('Experiment incomplete; no artifact was published');

const summarise = (conditionId) => {
  const subset = records.filter((row) => row.condition === conditionId);
  const rate = (key) => Number((subset.filter((row) => row[key]).length / subset.length).toFixed(4));
  const mean = (key) => Number((subset.reduce((sum, row) => sum + (row[key] || 0), 0) / subset.length).toFixed(2));
  return {
    n: subset.length,
    declaredAccuracy: rate('declaredCorrect'),
    lenientAccuracy: rate('lenientCorrect'),
    reasoningAccuracy: rate('reasoningCorrect'),
    parseFailureRate: rate('parseFailed'),
    formatGap: Number((rate('lenientCorrect') - rate('declaredCorrect')).toFixed(4)),
    meanSeconds: mean('seconds'),
    meanContentChars: mean('contentChars'),
    meanReasoningChars: mean('reasoningChars'),
    errors: subset.filter((row) => row.error).length
  };
};

const summary = Object.fromEntries(CONDITIONS.map((condition) => [condition.id, summarise(condition.id)]));
const baseline = summary.direct.declaredAccuracy;

const artifact = {
  generatedAt: previous?.generatedAt || new Date().toISOString(),
  model: MODEL,
  dataset: 'GSM8K test split (Cobbe et al., 2021)',
  seed: SEED,
  sampledQuestions: sampled.length,
  conditions: CONDITIONS,
  summary,
  records,
  ...(previous?.repairs || previous?.records?.some((record) => record.error)
    ? { repairs: [
      ...(previous.repairs || []),
      ...previous.records.filter((record) => record.error).map((record) => ({
        condition: record.condition,
        index: record.index,
        originalError: record.error,
        originalSeconds: record.seconds,
        repairedAt: new Date().toISOString()
      }))
    ] }
    : {})
};
assertExperimentArtifact(artifact, OUT);
const temporary = `${OUT}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
await fs.rename(temporary, OUT);

console.log('\n=== accuracy by condition ===');
console.log('condition  declared  lenient  reasoning  parse-fail  format-gap  secs');
for (const condition of CONDITIONS) {
  const s = summary[condition.id];
  console.log(`${condition.id.padEnd(10)} ${String(s.declaredAccuracy).padEnd(9)} ${String(s.lenientAccuracy).padEnd(8)} ${String(s.reasoningAccuracy).padEnd(10)} ${String(s.parseFailureRate).padEnd(11)} ${String(s.formatGap).padEnd(11)} ${s.meanSeconds}`);
}
console.log(`\ndirect declared accuracy (baseline): ${baseline}`);
for (const condition of CONDITIONS.filter((c) => c.id !== 'direct')) {
  const delta = Number((summary[condition.id].declaredAccuracy - baseline).toFixed(4));
  console.log(`  ${condition.id.padEnd(8)} delta vs direct: ${delta >= 0 ? '+' : ''}${delta}`);
}
console.log(`\nraw: ${path.relative(REPO_ROOT, OUT)}`);
