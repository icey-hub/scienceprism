import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config/constants.js';
import { getProjectRoot } from './projectService.js';
import { assertCapability, assertProjectPath } from './harnessRuntime/capabilities.js';

export const SKILLS_ROOT = path.join(REPO_ROOT, '.dsh', 'skills');

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
  const isLiteral = /:\s*\|/.test(frontmatter[headerIndex]);
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
      if (!stagesMatch[1].startsWith('[') || !stagesMatch[1].endsWith(']')) return null;
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
  if (!SKILL_NAME_PATTERN.test(name) || !description || stages.some((stage) => !STAGE_SET.has(normalizeStage(stage)))) return null;
  return { name, description, stages: normalizedStages };
}

function unavailable(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function readDocument(root, name, file, capabilityPolicy, source) {
  if (!SKILL_NAME_PATTERN.test(name)) throw unavailable('INVALID_NAME');
  const relativeFile = String(file || 'SKILL.md').replace(/\\/g, '/');
  if (!relativeFile.endsWith('.md') || path.posix.isAbsolute(relativeFile) || /[\x00-\x1f:]/.test(relativeFile) || relativeFile.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Skill file must stay inside its Skill folder.');
  }
  if (capabilityPolicy) assertCapability(capabilityPolicy, 'project.read');
  if (source === 'project' && capabilityPolicy) {
    assertProjectPath(path.posix.join('.dsh', 'skills', name, relativeFile), capabilityPolicy, { operation: 'read' });
  }
  const rootReal = await fs.realpath(root);
  const folder = path.join(root, '.dsh', 'skills', name);
  const folderReal = await fs.realpath(folder);
  if (!folderReal.startsWith(`${rootReal}${path.sep}`)) throw unavailable('PATH_ESCAPE');
  const fileReal = await fs.realpath(path.join(folder, relativeFile));
  if (!fileReal.startsWith(`${folderReal}${path.sep}`)) throw new Error('Skill file escapes its Skill folder.');
  const stat = await fs.stat(fileReal);
  if (!stat.isFile() || stat.size > 128_000) throw unavailable('TOO_LARGE_OR_NOT_FILE');
  return fs.readFile(fileReal, 'utf8');
}

async function scan(root, source, capabilityPolicy) {
  let entries;
  const folder = path.join(root, '.dsh', 'skills');
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skill = { name: entry.name, description: '', stages: [], source, relativePath: path.posix.join('.dsh', 'skills', entry.name, 'SKILL.md'), available: false, reason: null };
    try {
      const metadata = parseSkillFrontmatter(await readDocument(root, entry.name, 'SKILL.md', capabilityPolicy, source));
      if (!metadata || metadata.name !== entry.name) throw unavailable('INVALID_METADATA');
      Object.assign(skill, metadata, { available: true });
    } catch (error) {
      skill.reason = ['CAPABILITY_DENIED', 'PATH_DENIED'].includes(error.code) ? 'PERMISSION_DENIED'
        : /escapes/.test(error.message) ? 'PATH_ESCAPE'
          : ({ ENOENT: 'MISSING_DOCUMENT', EACCES: 'PERMISSION_DENIED', EPERM: 'PERMISSION_DENIED' }[error.code] || error.code || 'UNREADABLE_DOCUMENT');
    }
    skills.push(skill);
  }
  return skills;
}

/** Metadata only. A project definition shadows its built-in even when invalid. */
export async function listSkillCatalog({ projectId, projectRoot, capabilityPolicy } = {}) {
  const root = projectRoot || (projectId ? await getProjectRoot(projectId) : null);
  const [bundled, local] = await Promise.all([
    scan(REPO_ROOT, 'built-in', capabilityPolicy), root ? scan(root, 'project', capabilityPolicy) : []
  ]);
  const byName = new Map(bundled.map((skill) => [skill.name, skill]));
  for (const skill of local) {
    if (byName.has(skill.name)) skill.shadows = 'built-in';
    byName.set(skill.name, skill);
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** On-demand Markdown only; selection never grants new execution capabilities. */
export async function readEnabledSkillDocument({ projectId, enabledSkillNames = [], name, file = 'SKILL.md', capabilityPolicy } = {}) {
  if (!projectId || !uniqueStrings(enabledSkillNames).includes(name)) throw new Error('Skill is not enabled for this Run.');
  const { skills } = await listSkillCatalog({ projectId, capabilityPolicy });
  const skill = skills.find((item) => item.name === name);
  if (!skill?.available) {
    if (skill?.reason === 'PERMISSION_DENIED') throw new Error('Harness path denied for Skill.');
    throw new Error(`Skill is unavailable: ${skill?.reason || 'NOT_FOUND'}`);
  }
  const root = skill.source === 'project' ? await getProjectRoot(projectId) : REPO_ROOT;
  const content = await readDocument(root, name, file, capabilityPolicy, skill.source);
  return content.length > 40_000 ? `${content.slice(0, 40_000)}\n\n[Skill document truncated after 40,000 characters]` : content;
}
