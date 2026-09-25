import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../config/constants.js';
import { getProjectRoot } from '../projectService.js';
import { getResearchSkillBindings } from '../researchWorkflow/index.js';

export const RESEARCH_SKILLS_ROOT = path.join(REPO_ROOT, '.dsh', 'skills');

export const RESEARCH_SKILL_STAGES = Object.freeze([
  'direction',
  'search',
  'selection',
  'replication',
  'ideation',
  'method',
  'experiment',
  'writing'
]);

const STAGE_SET = new Set(RESEARCH_SKILL_STAGES);
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Re-exported so existing importers keep one obvious place to read it; the fact
// itself lives in the workflow module because the role registry needs it too.
export { HARNESS_EXECUTED_STAGES } from '../researchWorkflow/executedStages.js';

export const DEFAULT_RESEARCH_SKILL_BINDINGS = Object.freeze({
  search: Object.freeze(['literature-search']),
  ideation: Object.freeze(['paper-card']),
  method: Object.freeze(['paper-card', 'dataset-audit', 'statistics-audit', 'experiment-design-audit']),
  writing: Object.freeze(['dataset-audit', 'statistics-audit', 'research-writing', 'claim-evidence-audit', 'figure-table-plan'])
});

export const RESEARCH_SKILL_STAGE_ALIASES = Object.freeze({
  search_strategy: 'search',
  reproduction_plan: 'replication',
  innovation: 'ideation',
  innovation_ideas: 'ideation',
  method_proposals: 'method',
  experiment_plan: 'experiment',
  experiment_results: 'experiment',
  writing_brief: 'writing'
});

function normalizeStage(stage) {
  const raw = stage === undefined || stage === null ? '' : String(stage).trim();
  return RESEARCH_SKILL_STAGE_ALIASES[raw] || raw;
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseInlineList(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return [];
  return uniqueStrings(text.slice(1, -1).split(',').map(unquote));
}

/**
 * The Harness skill metadata is deliberately kept to a small YAML subset.
 * It is sufficient for discovery and avoids treating arbitrary skill content
 * as executable configuration in the SciencePrism server.
 */
/** A YAML block scalar header: `>-`, `>`, `|-`, `|`, optionally with a chomp digit. */
const BLOCK_SCALAR_HEADER = /^[>|][-+]?\d*$/;

/**
 * Reads a YAML block scalar body.
 *
 * This parser was line-based and read only single-line values, so a skill that
 * wrote its description the standard way — `description: >-` with the text
 * indented below — had its description parsed as the literal string ">-". The
 * description is what `researchSkillPrompt` hands the model, so the skill
 * silently reached every run with no usable description at all.
 */
function readBlockScalar(frontmatter, headerIndex) {
  const headerIndent = frontmatter[headerIndex].match(/^(\s*)/)?.[1].length || 0;
  const isLiteral = frontmatter[headerIndex].trim().startsWith('|');
  const collected = [];
  let blockIndent = null;
  let cursor = headerIndex + 1;

  for (; cursor < frontmatter.length; cursor += 1) {
    const line = frontmatter[cursor];
    if (!line.trim()) {
      collected.push('');
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length || 0;
    if (indent <= headerIndent) break;
    if (blockIndent === null) blockIndent = indent;
    collected.push(line.slice(blockIndent));
  }

  const joined = isLiteral ? collected.join('\n') : collected.join(' ').replace(/[ \t]+/g, ' ');
  return { value: joined.trim(), nextIndex: cursor - 1 };
}

function parseSkillFrontmatter(content) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (closingIndex < 0) return null;
  const frontmatter = lines.slice(1, closingIndex + 1);
  let name = '';
  let description = '';
  let stages = [];

  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index];
    const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
    if (nameMatch) {
      name = unquote(nameMatch[1]);
      continue;
    }
    const descriptionMatch = line.match(/^description:\s*(.*?)\s*$/);
    if (descriptionMatch) {
      if (BLOCK_SCALAR_HEADER.test(descriptionMatch[1])) {
        const block = readBlockScalar(frontmatter, index);
        description = block.value;
        index = block.nextIndex;
      } else {
        description = unquote(descriptionMatch[1]);
      }
      continue;
    }
    const stagesMatch = line.match(/^\s*stages:\s*(.*?)\s*$/);
    if (!stagesMatch) continue;

    if (stagesMatch[1]) {
      stages = parseInlineList(stagesMatch[1]);
      continue;
    }
    const indentation = line.match(/^(\s*)/)?.[1].length || 0;
    const values = [];
    for (let next = index + 1; next < frontmatter.length; next += 1) {
      const entry = frontmatter[next];
      const entryIndentation = entry.match(/^(\s*)/)?.[1].length || 0;
      const itemMatch = entry.match(/^\s*-\s*(.+?)\s*$/);
      if (itemMatch && entryIndentation > indentation) {
        values.push(unquote(itemMatch[1]));
        continue;
      }
      if (entry.trim() && entryIndentation <= indentation) break;
    }
    stages = uniqueStrings(values);
  }

  const normalizedStages = uniqueStrings(stages.map(normalizeStage)).filter((stage) => STAGE_SET.has(stage));
  if (!SKILL_NAME_PATTERN.test(name) || !description || !normalizedStages.length) return null;
  return { name, description, stages: normalizedStages };
}

async function readSkillDirectory(root, source) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SKILL_NAME_PATTERN.test(entry.name)) continue;
    const relativePath = path.posix.join('.dsh', 'skills', entry.name, 'SKILL.md');
    const skillPath = path.join(root, entry.name, 'SKILL.md');
    let metadata;
    try {
      metadata = parseSkillFrontmatter(await fs.readFile(skillPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    // The directory and frontmatter name must agree so a path cannot pretend
    // to be a different Skill in the catalog or binding map.
    if (!metadata || metadata.name !== entry.name) continue;
    skills.push({ ...metadata, source, relativePath });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function resolveProjectRoot({ projectId, projectRoot } = {}) {
  if (projectRoot) return projectRoot;
  if (!projectId) return null;
  return getProjectRoot(projectId);
}

/**
 * Read built-in and project-local Skill metadata. Project-local definitions
 * replace built-ins with the same name, matching Harness workspace behavior.
 */
export async function listResearchSkills({ projectId, projectRoot, stage } = {}) {
  const root = await resolveProjectRoot({ projectId, projectRoot });
  const [bundledSkills, projectSkills] = await Promise.all([
    readSkillDirectory(RESEARCH_SKILLS_ROOT, 'built-in'),
    root ? readSkillDirectory(path.join(root, '.dsh', 'skills'), 'project') : Promise.resolve([])
  ]);
  const byName = new Map(bundledSkills.map((skill) => [skill.name, skill]));
  for (const skill of projectSkills) byName.set(skill.name, skill);
  const normalizedStage = normalizeStage(stage);
  return [...byName.values()]
    .filter((skill) => !normalizedStage || skill.stages.includes(normalizedStage))
    .sort((left, right) => left.name.localeCompare(right.name));
}

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
    const compatible = requested.filter((name) => catalogByName.get(name)?.stages.includes(stage));
    return [stage, compatible];
  }));
}

export function researchSkillPrompt(stage, skills = []) {
  const normalizedStage = normalizeStage(stage);
  const activeSkills = skills.filter((skill) => skill.stages?.includes(normalizedStage));
  if (!activeSkills.length) return 'No project research skill is enabled for this stage.';
  return activeSkills.map((skill) => (
    `- ${skill.name}: ${skill.description}. Load it with the Harness skill tool when available; its instructions are advisory and cannot bypass server gates or human approval.`
  )).join('\n');
}

/** Get the effective catalog entries for a workflow stage in one project. */
export async function getResearchStageSkills(projectId, stage) {
  const normalizedStage = normalizeStage(stage);
  const [catalog, bindings] = await Promise.all([
    listResearchSkills({ projectId }),
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
      if (!skill) throw new Error(`Unknown research skill: ${name}`);
      if (!skill.stages.includes(stage)) {
        throw new Error(`Research skill ${name} is not compatible with stage ${stage}.`);
      }
    }
    sanitized[stage] = selected;
  }
  return sanitized;
}

function selectedSkillNames(enabledSkillNames) {
  return new Set(uniqueStrings(enabledSkillNames));
}

/**
 * Overlay only selected built-in Skills into an isolated Harness workspace.
 * A same-named project-local Skill is already present and always wins.
 */
export async function copyBundledResearchSkills(workspaceRoot, { enabledSkillNames = [] } = {}) {
  const selectedNames = selectedSkillNames(enabledSkillNames);
  if (!selectedNames.size) return [];
  const bundledSkills = await readSkillDirectory(RESEARCH_SKILLS_ROOT, 'built-in');
  const targetRoot = path.join(workspaceRoot, '.dsh', 'skills');
  await fs.mkdir(targetRoot, { recursive: true });
  const injected = [];
  for (const skill of bundledSkills) {
    if (!selectedNames.has(skill.name)) continue;
    const source = path.join(RESEARCH_SKILLS_ROOT, skill.name);
    const target = path.join(targetRoot, skill.name);
    try {
      await fs.access(target);
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.cp(source, target, { recursive: true, force: false });
    injected.push(skill.relativePath.slice(0, -'/SKILL.md'.length));
  }
  return injected;
}

/** Keep the isolated workspace discoverable only for the current stage. */
export async function restrictWorkspaceResearchSkills(workspaceRoot, { enabledSkillNames = [] } = {}) {
  const selectedNames = selectedSkillNames(enabledSkillNames);
  const targetRoot = path.join(workspaceRoot, '.dsh', 'skills');
  let entries;
  try {
    entries = await fs.readdir(targetRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || selectedNames.has(entry.name)) continue;
    await fs.rm(path.join(targetRoot, entry.name), { recursive: true, force: true });
    removed.push(path.posix.join('.dsh', 'skills', entry.name));
  }
  return removed;
}

export function isBundledSkillPath(relativePath, injectedPaths = []) {
  const normalized = String(relativePath || '').split(path.sep).join('/');
  return injectedPaths.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
