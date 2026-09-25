/**
 * Completeness checks for experiment artifacts written into aidoc/.
 *
 * Two real accidents motivate this module, both of the same shape: an experiment
 * driver finished "successfully" while its data was silently incomplete.
 *
 *   1. A two-question smoke run overwrote the 600-generation CoT dataset.
 *   2. The shared gateway answers HTTP 502 "upstream_unavailable" after its own
 *      120 s upstream timeout. A driver that catches that error and records a null
 *      answer ships a transport failure as if it were a wrong answer. That is what
 *      happened to condition "format", index 173, of the 600-generation run, and it
 *      inflated the reported cost of explicit answer formatting.
 *
 * A failed call is not a wrong answer. These checks make that distinction
 * executable: a cell that never produced a sample is a defect to re-run, not a
 * data point to analyse.
 */

const MAX_LISTED = 5;

function conditionIds(document) {
  if (!Array.isArray(document?.conditions)) return null;
  return document.conditions.map((condition) => (typeof condition === 'string' ? condition : condition?.id)).filter(Boolean);
}

function questionCount(document) {
  const declared = document?.sampledQuestions ?? document?.planned;
  return Number.isFinite(Number(declared)) ? Number(declared) : null;
}

function list(items) {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown}, ... (+${items.length - MAX_LISTED} more)` : shown;
}

/**
 * @returns {{ ok: boolean, problems: string[], checked: { records: number, cells: number|null } }}
 */
export function checkExperimentArtifact(document, name = 'artifact') {
  const problems = [];
  const records = document?.records;

  if (!Array.isArray(records)) return { ok: false, problems: [`${name}: no records array`], checked: { records: 0, cells: null } };
  if (!records.length) return { ok: false, problems: [`${name}: records array is empty`], checked: { records: 0, cells: null } };

  const ids = conditionIds(document);
  const questions = questionCount(document);
  let cells = null;

  // Grid completeness: every (condition, question) cell exactly once. This is what
  // a truncated or overwritten run violates, and it is invisible in the summary.
  if (ids && ids.length && questions) {
    cells = ids.length * questions;
    if (records.length !== cells) {
      problems.push(`${name}: ${records.length} records but ${questions} questions x ${ids.length} conditions = ${cells}`);
    }
    const seen = new Set();
    const duplicates = [];
    for (const record of records) {
      const key = `${record?.condition}#${record?.index}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    if (duplicates.length) problems.push(`${name}: duplicate cell(s): ${list(duplicates)}`);
    const missing = [];
    for (const id of ids) {
      for (let index = 0; index < questions; index += 1) {
        if (!seen.has(`${id}#${index}`)) missing.push(`${id}#${index}`);
      }
    }
    if (missing.length) problems.push(`${name}: missing cell(s): ${list(missing)}`);
  } else if (questions && records.length !== questions) {
    cells = questions;
    problems.push(`${name}: ${records.length} records but ${questions} were planned`);
  }

  // A transport failure is not a data point. It must be re-run before shipping.
  const failed = records.filter((record) => record?.error).map((record) => `${record.condition ?? ''}#${record.index}: ${record.error}`);
  if (failed.length) problems.push(`${name}: ${failed.length} record(s) failed at the transport layer and must be re-run, not analysed: ${list(failed)}`);

  // Sampling completeness: with k draws per item, a short record is a lost draw.
  const k = Number(document?.k);
  if (Number.isFinite(k) && k > 0) {
    const short = records.filter((record) => !Array.isArray(record?.answers) || record.answers.length !== k)
      .map((record) => `${record?.index} (${Array.isArray(record?.answers) ? record.answers.length : 0}/${k})`);
    if (short.length) problems.push(`${name}: ${short.length} record(s) have fewer than k=${k} samples: ${list(short)}`);
  }

  return { ok: problems.length === 0, problems, checked: { records: records.length, cells } };
}

/** Refuse to write an incomplete artifact over a good one. */
export function assertExperimentArtifact(document, name = 'artifact') {
  const result = checkExperimentArtifact(document, name);
  if (!result.ok) throw new Error(`incomplete experiment artifact:\n  - ${result.problems.join('\n  - ')}`);
  return result;
}
