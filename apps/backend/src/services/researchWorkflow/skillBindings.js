import { ResearchWorkflowError } from './errors.js';
import { STAGE_IDS } from './stageContracts.js';

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function skillBindingError(message, details, { stored = false } = {}) {
  return new ResearchWorkflowError(
    stored ? 500 : 400,
    stored ? 'WORKFLOW_CORRUPT' : 'INVALID_SKILL_BINDINGS',
    message,
    details
  );
}

function normalizeSkillName(name, { stored = false } = {}) {
  if (typeof name !== 'string') throw skillBindingError('Each skill name must be a string.', { name }, { stored });
  const normalized = name.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(normalized)) {
    throw skillBindingError('Skill names must use normalized kebab-case.', { name }, { stored });
  }
  return normalized;
}

export function normalizeSkillBindings(bindings, { stored = false, requireNormalized = false } = {}) {
  if (bindings === undefined || bindings === null) bindings = {};
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw skillBindingError('skillBindings must be an object keyed by research workflow stage.', undefined, { stored });
  }
  const normalizedBindings = {};
  for (const [stageId, skillNames] of Object.entries(bindings)) {
    if (!STAGE_IDS.has(stageId)) {
      throw skillBindingError('skillBindings includes an unknown research workflow stage.', { stageId, allowedStages: [...STAGE_IDS] }, { stored });
    }
    if (!Array.isArray(skillNames)) throw skillBindingError('Each skillBindings stage value must be an array.', { stageId }, { stored });
    const names = [];
    const seen = new Set();
    for (const skillName of skillNames) {
      const normalizedName = normalizeSkillName(skillName, { stored });
      if (requireNormalized && skillName !== normalizedName) {
        throw skillBindingError('Stored skill names must use normalized kebab-case.', { stageId, name: skillName }, { stored });
      }
      if (!seen.has(normalizedName)) {
        seen.add(normalizedName);
        names.push(normalizedName);
      }
    }
    normalizedBindings[stageId] = names;
  }
  return normalizedBindings;
}

