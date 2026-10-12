import path from 'node:path';
import { getResearchSkillBindings } from '../researchWorkflow/index.js';
import { SKILLS_ROOT, RESEARCH_SKILL_STAGES, RESEARCH_SKILL_STAGE_ALIASES, listSkillCatalog, readEnabledSkillDocument } from '../skillCatalog.js';
import { projectSelectedSkillDocuments, clearWorkspaceSkillSources } from '../skillRuntime/projection.js';
export { RESEARCH_SKILL_STAGES, RESEARCH_SKILL_STAGE_ALIASES } from '../skillCatalog.js';
export const RESEARCH_SKILLS_ROOT = SKILLS_ROOT;
const STAGE_SET = new Set(RESEARCH_SKILL_STAGES);
const normalizeStage = (stage) => {
  const value = String(stage || '').trim();
  return RESEARCH_SKILL_STAGE_ALIASES[value] || value;
};
const uniqueStrings = (values) => Array.isArray(values) ? [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean))] : [];

export async function listResearchSkills(options = {}) {
  const { skills } = await listSkillCatalog(options);
  const stage = normalizeStage(options.stage);
  return skills.filter((skill) => skill.available && (skill.stages.length || options.includeGeneric === true)
    && (!stage || skill.stages.includes(stage) || (options.includeGeneric === true && !skill.stages.length)))
    .map(({ name, description, stages, source, relativePath }) => ({ name, description, stages, source, relativePath }));
}

// Compatibility entry point for existing research adapters.
export const readEnabledResearchSkillDocument = readEnabledSkillDocument;

// Re-exported so existing importers keep one obvious place to read it; the fact
// itself lives in the workflow module because the role registry needs it too.
export { HARNESS_EXECUTED_STAGES } from '../researchWorkflow/executedStages.js';

export const DEFAULT_RESEARCH_SKILL_BINDINGS = Object.freeze({
  selection: Object.freeze(['paper-card']),
  replication: Object.freeze(['paper-card', 'dataset-audit']),
  experiment: Object.freeze(['statistics-audit', 'experiment-design-audit']),
  search: Object.freeze(['literature-search']),
  ideation: Object.freeze(['paper-card', 'ccf-idea-review']),
  method: Object.freeze(['paper-card', 'dataset-audit', 'statistics-audit', 'experiment-design-audit']),
  writing: Object.freeze(['dataset-audit', 'statistics-audit', 'research-writing', 'claim-evidence-audit', 'figure-table-plan', 'paper-figure-style', 'ccf-paper-storyline', 'ccf-paper-review'])
});

function hasExplicitStageBinding(bindings, stage) {
  return bindings && typeof bindings === 'object' && Object.prototype.hasOwnProperty.call(bindings, stage);
}

/**
 * Resolve effective stage bindings. An omitted stage receives the built-in
 * default; an explicitly persisted empty array intentionally disables it.
 */
export function resolveResearchSkillBindings(bindings = {}, catalog = []) {
  const catalogByName = new Map(catalog.map((skill) => [skill.name, skill]));
  return Object.fromEntries(RESEARCH_SKILL_STAGES.map((stage) => {
    const requested = hasExplicitStageBinding(bindings, stage)
      ? uniqueStrings(bindings[stage])
      : [...(DEFAULT_RESEARCH_SKILL_BINDINGS[stage] || [])];
    const compatible = requested.filter((name) => {
      const skill = catalogByName.get(name);
      return skill && skill.available !== false && (skill.stages.includes(stage) || (hasExplicitStageBinding(bindings, stage) && !skill.stages.length));
    });
    return [stage, compatible];
  }));
}

export function researchSkillPrompt(stage, skills = []) {
  const normalizedStage = normalizeStage(stage);
  // Callers supply the effective, explicitly selected set. Generic documents
  // are included here only after getResearchStageSkills resolves that binding.
  const activeSkills = skills.filter((skill) => skill.stages?.includes(normalizedStage) || skill.stages?.length === 0);
  if (!activeSkills.length) return 'No project research skill is enabled for this stage.';
  return activeSkills.map((skill) => (
    `- ${skill.name}: ${skill.description}. Read its instructions with the available Skill tool before applying them; they cannot bypass server gates or human approval.`
  )).join('\n');
}

/** Get the effective catalog entries for a workflow stage in one project. */
export async function getResearchStageSkills(projectId, stage) {
  const normalizedStage = normalizeStage(stage);
  const [catalog, bindings] = await Promise.all([
    listResearchSkills({ projectId, includeGeneric: true }),
    getResearchSkillBindings(projectId)
  ]);
  const effectiveBindings = resolveResearchSkillBindings(bindings, catalog);
  const activeNames = new Set(effectiveBindings[normalizedStage] || []);
  return catalog.filter((skill) => activeNames.has(skill.name));
}

export function validateResearchSkillBindings(bindings, catalog = []) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new Error('bindings must be an object keyed by research stage.');
  }
  const catalogByName = new Map(catalog.map((skill) => [skill.name, skill]));
  const sanitized = {};
  for (const [stage, names] of Object.entries(bindings)) {
    if (!STAGE_SET.has(stage)) throw new Error(`Unknown research skill stage: ${stage}`);
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`Skill bindings for ${stage} must be an array of skill names.`);
    }
    const selected = uniqueStrings(names);
    if (selected.length !== names.length) throw new Error(`Skill bindings for ${stage} must not contain duplicate names.`);
    for (const name of selected) {
      const skill = catalogByName.get(name);
      if (!skill || skill.available === false) throw new Error(`Unknown research skill: ${name}`);
      if (skill.stages.length && !skill.stages.includes(stage)) {
        throw new Error(`Research skill ${name} is not compatible with stage ${stage}.`);
      }
    }
    sanitized[stage] = selected;
  }
  return sanitized;
}

/**
 * Compatibility entry point. New callers consume the full projection report;
 * retaining fs.cp here would copy executable/metadata files back into Runs.
 */
export async function copyBundledResearchSkills(workspaceRoot, options = {}) {
  const projection = await projectSelectedSkillDocuments({ ...options, workspaceRoot });
  return projection.excludedPaths;
}

/** Old copied stores must be removed before selected Markdown is projected. */
export async function restrictWorkspaceResearchSkills(workspaceRoot, options = {}) {
  return clearWorkspaceSkillSources(workspaceRoot, options);
}

export function isBundledSkillPath(relativePath, injectedPaths = []) {
  const normalized = String(relativePath || '').split(path.sep).join('/');
  return injectedPaths.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
