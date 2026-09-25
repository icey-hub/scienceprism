#!/usr/bin/env node
/**
 * Self-consistency ablation: is the gain from sampling, or from voting?
 *
 * Self-consistency (Wang et al., 2022) samples k solutions and takes the majority
 * answer. It bundles two mechanisms: more samples (a wider search) and majority
 * voting (an aggregation rule). Reporting one accuracy number conflates them.
 * This separates them by measuring, on the same items and the same sampler:
 *
 *   single  one sample at temperature 0.7, which is the search budget of one
 *   selfcons  k samples, majority answer
 *   oracle   k samples, correct if ANY sample is right, which is the ceiling the
 *            k samples make available
 *
 * single versus selfcons isolates the vote. selfcons versus oracle shows how much
 * of the available gain voting actually captures.
 *
 * Writes to its own file. It must never overwrite experiment-cot-gsm8k.json:
 * that holds the 600-generation run, and a smoke run once destroyed it.
 *
 * Usage: node scripts/experiment-self-consistency.mjs [questions] [k] [seed]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, sampleByHash } from './lib/script-helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await loadDotEnv(REPO_ROOT);

const COUNT = Number(process.argv[2]) || 60;
const K = Number(process.argv[3]) || 5;
const SEED = process.argv[4] || 'selfconsistency-2026';
const TEMPERATURE = 0.7;

const DATASET = path.join(REPO_ROOT, 'aidoc', 'datasets', 'gsm8k-test.jsonl');
const OUT = path.join(REPO_ROOT, 'aidoc', 'experiment-self-consistency.json');
const CHECKPOINT = path.join(REPO_ROOT, '.cache', 'experiment-self-consistency-checkpoint.json');

const ENDPOINT = process.env.SCIENCEPRISM_LLM_ENDPOINT;
const API_KEY = process.env.SCIENCEPRISM_LLM_API_KEY;
const MODEL = process.env.SCIENCEPRISM_LLM_MODEL;

const SYSTEM = 'Solve the problem. Think step by step, then end with a line exactly of the form: The answer is <number>.';

// The shared gateway intermittently answers 502 "upstream_unavailable" after its own
// 120 s upstream timeout. That is a transport failure, not a wrong answer, so it must
// be retried and, if it still fails, reported -- never silently counted as incorrect.
const MAX_ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 180_000;
const RETRY_BACKOFF_MS = 3_000;

function lastNumber(text) {
  const cleaned = String(text || '').replace(/,/g, '');
  const matches = [...cleaned.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => match[0]);
  return matches.length ? String(Number(matches[matches.length - 1])) : null;
}

/** Most common value; null when there is no unique mode (untied votes are failures). */
function majority(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null;
  let bestCount = 0;
  let tied = false;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
      tied = false;
    } else if (count === bestCount && value !== best) {
      tied = true;
    }
  }
  return tied ? null : best;
}

const rows = (await fs.readFile(DATASET, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const sampled = sampleByHash(rows, SEED, (row, index) => index, COUNT);

/**
 * One sample. Returns the parsed answer plus the wall time, or throws with the
 * transport reason so the caller can retry and, failing that, record it loudly.
 */
async function draw(question) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(`${ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: TEMPERATURE,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: question }
          ]
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
      });
      const raw = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${raw.slice(0, 160)}`;
      } else {
        const data = JSON.parse(raw);
        const content = String(data?.choices?.[0]?.message?.content || '');
        if (content.trim()) {
          return { answer: lastNumber(content), seconds: Number(((Date.now() - started) / 1000).toFixed(2)), attempts: attempt };
        }
        lastError = 'empty content';
      }
    } catch (error) {
      lastError = `${error?.name || 'Error'}: ${error?.message || ''}`;
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
  }
  throw new Error(`sample failed after ${MAX_ATTEMPTS} attempts (${lastError})`);
}

/** Atomic checkpoint: a kill must never destroy the records already paid for. */
async function checkpoint(records, complete) {
  await fs.mkdir(path.dirname(CHECKPOINT), { recursive: true });
  const temporary = `${CHECKPOINT}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: MODEL,
    dataset: 'GSM8K test split (Cobbe et al., 2021)',
    seed: SEED,
    k: K,
    temperature: TEMPERATURE,
    planned: sampled.length,
    complete,
    ...summarise(records),
    records
  }, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, CHECKPOINT);
}

function summarise(records) {
  if (!records.length) return { n: 0 };
  const rate = (key) => Number((records.filter((record) => record[key]).length / records.length).toFixed(4));
  const summary = {
    n: records.length,
    singleAccuracy: rate('singleCorrect'),
    selfconsAccuracy: rate('selfconsCorrect'),
    oracleAccuracy: rate('oracleCorrect'),
    meanSampleAccuracy: Number((records.reduce((sum, record) => sum + record.meanSampleCorrect, 0) / records.length).toFixed(4))
  };
  summary.voteGain = Number((summary.selfconsAccuracy - summary.singleAccuracy).toFixed(4));
  summary.searchHeadroom = Number((summary.oracleAccuracy - summary.selfconsAccuracy).toFixed(4));
  return summary;
}

// Resume at draw granularity. The gateway fails intermittently, so the unit of
// progress must be one draw: losing a whole record because its third draw 502ed
// makes a flaky transport cost hours instead of seconds.
const state = new Map();
try {
  const previous = JSON.parse(await fs.readFile(CHECKPOINT, 'utf8'));
  if (previous.seed === SEED && previous.k === K && previous.temperature === TEMPERATURE && previous.planned === sampled.length) {
    for (const record of previous.records || []) {
      if (record.index < sampled.length) state.set(record.index, record);
    }
    const held = [...state.values()].reduce((sum, record) => sum + (record.answers?.length || 0), 0);
    if (held) console.log(`resume  : kept ${state.size} partial record(s) holding ${held} draw(s)\n`);
  }
} catch {
  // No usable previous run; start clean.
}

console.log(`dataset : GSM8K test, ${rows.length} questions, sampled ${sampled.length} (seed ${SEED})`);
console.log(`model   : ${MODEL}`);
console.log(`design  : temperature ${TEMPERATURE}, k = ${K}, up to ${sampled.length * K} serial calls\n`);

/** Rebuild the derived fields of a record from the draws it currently holds. */
function materialise(index, gold, answers, seconds, errors) {
  const vote = majority(answers);
  return {
    index,
    gold,
    answers,
    seconds,
    errors,
    single: answers[0] ?? null,
    selfcons: vote,
    singleCorrect: answers.length > 0 && answers[0] === gold,
    selfconsCorrect: answers.length === K && vote === gold,
    oracleCorrect: answers.some((answer) => answer === gold),
    meanSampleCorrect: answers.filter((answer) => answer === gold).length / K,
    samples: answers.length
  };
}

const snapshot = () => [...state.values()].sort((left, right) => left.index - right.index);

for (let index = 0; index < sampled.length; index += 1) {
  const item = sampled[index];
  const gold = String(Number(String(item.answer.split('####').pop()).replace(/,/g, '').trim()));
  const held = state.get(index);
  const answers = held?.answers ? [...held.answers] : [];
  const seconds = held?.seconds ? [...held.seconds] : [];
  const errors = held?.errors ? [...held.errors] : [];

  while (answers.length < K) {
    try {
      const result = await draw(item.question);
      answers.push(result.answer);
      seconds.push(result.seconds);
      console.log(`  item ${String(index).padStart(2)}  draw ${answers.length}/${K}  ${String(result.answer).padStart(8)}  ${result.seconds}s${result.attempts > 1 ? ` (attempt ${result.attempts})` : ''}`);
    } catch (error) {
      errors.push(error.message);
      console.log(`  item ${String(index).padStart(2)}  draw ${answers.length + 1}/${K}  FAILED  ${error.message}`);
      break;
    }
    state.set(index, materialise(index, gold, answers, seconds, errors));
    await checkpoint(snapshot(), [...state.values()].filter((record) => record.answers.length === K).length);
  }

  if (!state.has(index)) state.set(index, materialise(index, gold, answers, seconds, errors));
  const completeNow = [...state.values()].filter((record) => record.answers.length === K).length;
  if (completeNow % 10 === 0 && answers.length === K) {
    const correct = [...state.values()].filter((record) => record.selfconsCorrect).length;
    console.log(`  --- ${String(completeNow).padStart(3)}/${sampled.length} complete  selfcons correct ${correct}`);
  }
}

const records = snapshot();
const incomplete = records.filter((record) => record.answers.length < K);
const completeRecords = records.filter((record) => record.answers.length === K);
const summary = summarise(completeRecords);
await checkpoint(records, completeRecords.length);

if (incomplete.length) {
  console.error(`\nINCOMPLETE: ${incomplete.length} item(s) still short of ${K} draws: ${incomplete.map((record) => `${record.index}(${record.answers.length}/${K})`).join(', ')}`);
  console.error('Re-run the same command: it resumes and only fetches the missing draws.');
  await fs.writeFile(path.join(REPO_ROOT, '.cache', 'selfconsistency-incomplete.json'), `${JSON.stringify(incomplete.map((record) => ({ index: record.index, got: record.answers.length, errors: record.errors })), null, 2)}\n`, 'utf8');
  process.exitCode = 1;
} else {
  const completeArtifact = JSON.parse(await fs.readFile(CHECKPOINT, 'utf8'));
  const { assertExperimentArtifact } = await import('./lib/experiment-artifacts.mjs');
  assertExperimentArtifact(completeArtifact, OUT);
  const temporary = `${OUT}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(completeArtifact, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, OUT);
}

console.log('\n=== self-consistency ablation ===');
console.log(`  single (k=1 sample)      ${summary.singleAccuracy}`);
console.log(`  self-consistency (majority) ${summary.selfconsAccuracy}   -> vote gain ${summary.voteGain >= 0 ? '+' : ''}${summary.voteGain}`);
console.log(`  oracle (any sample right) ${summary.oracleAccuracy}   -> headroom the k samples left on the table ${summary.searchHeadroom}`);
console.log(`  mean per-sample accuracy ${summary.meanSampleAccuracy}`);
console.log(`\nraw: ${path.relative(REPO_ROOT, incomplete.length ? CHECKPOINT : OUT)}`);
