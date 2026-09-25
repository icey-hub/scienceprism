#!/usr/bin/env node
/** Rebuild every derived result from the complete raw CoT experiment. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExperimentArtifact } from './lib/experiment-artifacts.mjs';

const aidoc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../aidoc');
const raw = JSON.parse(await readFile(path.join(aidoc, 'experiment-cot-gsm8k.json'), 'utf8'));
assertExperimentArtifact(raw, 'experiment-cot-gsm8k.json');

const byCondition = Object.fromEntries(raw.conditions.map(({ id }) => [
  id,
  raw.records.filter((record) => record.condition === id).sort((a, b) => a.index - b.index)
]));
const rate = (count, total) => Number((count / total).toFixed(4));
const paired = (a, b) => {
  const result = { both: 0, onlyA: 0, onlyB: 0, neither: 0, discordant: 0 };
  for (let index = 0; index < raw.sampledQuestions; index += 1) {
    const left = byCondition[a][index].declaredCorrect;
    const right = byCondition[b][index].declaredCorrect;
    result[left ? (right ? 'both' : 'onlyA') : (right ? 'onlyB' : 'neither')] += 1;
  }
  result.discordant = result.onlyA + result.onlyB;
  return result;
};
const reasoningVsAnswer = { bothRight: 0, ansOnly: 0, reaOnly: 0, bothWrong: 0 };
for (const record of raw.records) {
  reasoningVsAnswer[record.declaredCorrect
    ? (record.reasoningCorrect ? 'bothRight' : 'ansOnly')
    : (record.reasoningCorrect ? 'reaOnly' : 'bothWrong')] += 1;
}
const difficulty = { allThreeRight: 0, allThreeWrong: 0, mixed: 0 };
for (let index = 0; index < raw.sampledQuestions; index += 1) {
  const correct = raw.conditions.filter(({ id }) => byCondition[id][index].declaredCorrect).length;
  difficulty[correct === 3 ? 'allThreeRight' : correct === 0 ? 'allThreeWrong' : 'mixed'] += 1;
}
const analysis = {
  n: raw.sampledQuestions,
  model: raw.model,
  dataset: raw.dataset,
  summary: raw.summary,
  paired: {
    direct_vs_cot: paired('direct', 'cot'),
    direct_vs_format: paired('direct', 'format'),
    cot_vs_format: paired('cot', 'format')
  },
  reasoningVsAnswer,
  difficulty
};

const equivalent = raw.records.filter((record) =>
  !record.declaredCorrect && record.declared !== null &&
  Number.isFinite(Number(record.declared)) && Number(record.declared) === Number(record.gold));
const parseFailures = raw.records.filter((record) => record.parseFailed).length;
const correctedAccuracy = Object.fromEntries(raw.conditions.map(({ id }) => {
  const rows = byCondition[id];
  const strict = raw.summary[id].declaredAccuracy;
  const numericCorrected = rate(rows.filter((row) => row.declaredCorrect || equivalent.includes(row)).length, rows.length);
  return [id, { strict, numericCorrected, delta: Number((numericCorrected - strict).toFixed(4)) }];
}));
const artifacts = {
  gradingArtifact: {
    numericallyEqualButMarkedWrong: equivalent.length,
    parseFailures,
    examples: equivalent.map(({ condition, gold, declared }) => ({ condition, gold, predicted: declared }))
  },
  correctedAccuracy
};

await writeFile(path.join(aidoc, 'experiment-cot-gsm8k-analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
await writeFile(path.join(aidoc, 'experiment-cot-gsm8k-artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
console.log(`Rebuilt analysis and grading artifacts from ${raw.records.length} complete records.`);
