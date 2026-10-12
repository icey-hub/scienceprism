import path from 'node:path';
import { createHash } from 'node:crypto';
import { RESEARCH_SKILL_STAGES, RESEARCH_SKILL_STAGE_ALIASES } from '../skillCatalog.js';

// This is a read-only description inspector, not the installed Skill loader or
// a YAML executor. Unsupported YAML remains explicitly unknown for review.
function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) { try { const parsed = JSON.parse(text); return typeof parsed === 'string' ? parsed : null; } catch { return null; } }
  if (text.startsWith("'")) return /^'(?:[^']|'')*'$/.test(text) ? text.slice(1, -1).replace(/''/g, "'") : null;
  if (!text || /^[\[\]{}&*!]|^(?:null|true|false|~)$/i.test(text)) return null;
  return text.replace(/\s+#.*$/, '').trim();
}
export function inspectSkillDescription(content, directoryName) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  const fields = Object.create(null); const issues = [];
  if (lines[0]?.trim() !== '---' || end < 0) issues.push('missing-frontmatter');
  else for (let i = 1; i < end; i += 1) {
    const match = lines[i].match(/^(name|description|license|compatibility|allowed-tools|stages):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (Object.hasOwn(fields, key)) { fields[key] = null; issues.push(`duplicate-${key}`); continue; }
    if (/^[>|][-+]?\d*$/.test(raw)) {
      const body = []; let indent;
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        const line = lines[++i]; indent ??= line.match(/^(\s*)\S/)?.[1].length;
        body.push(line.slice(indent || 0));
      }
      fields[key] = body.join(raw.startsWith('|') ? '\n' : ' ').trim();
    } else if (key === 'stages') {
      if (/^\[.*\]$/.test(raw)) fields[key] = raw.slice(1, -1).split(',').map(scalar).filter(Boolean);
      else if (!raw.trim()) {
        const stages = [];
        while (i + 1 < end && /^\s+-\s+/.test(lines[i + 1])) stages.push(scalar(lines[++i].replace(/^\s+-\s+/, '')));
        fields[key] = stages.filter(Boolean);
      } else fields[key] = null;
    } else fields[key] = scalar(raw);
  }
  const validName = typeof fields.name === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(fields.name) && fields.name.length <= 64 && fields.name === directoryName;
  if (!validName) issues.push('invalid-or-unknown-name');
  if (!fields.description || fields.description.length > 1024) issues.push('invalid-or-unknown-description');
  const declaredStages = (Array.isArray(fields.stages) ? fields.stages : []).map(stage => RESEARCH_SKILL_STAGE_ALIASES[stage] || stage);
  if (declaredStages.some(stage => !RESEARCH_SKILL_STAGES.includes(stage))) issues.push('unknown-stage');
  return { name: validName ? fields.name : null, description: fields.description?.slice(0, 1024) || null,
    metadataStatus: issues.length ? 'unknown' : 'declared', issues,
    stages: [...new Set(declaredStages.filter(stage => RESEARCH_SKILL_STAGES.includes(stage)))],
    licenseDeclaration: fields.license?.slice(0, 1000) || null,
    compatibility: { status: 'unknown', declaration: fields.compatibility?.slice(0, 500) || null, runtimeVerified: false },
    capabilities: { status: fields['allowed-tools'] ? 'declared' : 'unknown', allowedTools: fields['allowed-tools']?.slice(0, 2000) || null,
      network: 'unknown', execution: 'unknown', grantsPermissions: false }
  };
}

const LICENSE = /^(?:licen[cs]e(?:\.[a-z0-9]+)?|copying(?:\.[a-z0-9]+)?)$/i;
const MANIFEST = /^(?:package\.json|requirements(?:[-_.][\w-]+)?\.txt|pyproject\.toml|environment\.ya?ml|Pipfile)$/;
const COMPANION = /(?:^|\/)(?:\.mcp\.json|\.app\.json|hooks\.json|\.codex-plugin\/plugin\.json|\.claude-plugin\/plugin\.json)$/;
function ancestors(directory) {
  const result = [directory];
  while (directory) { directory = path.posix.dirname(directory); if (directory === '.') directory = ''; result.push(directory); }
  return result;
}
const inDirectory = (file, directory) => !directory || file.startsWith(`${directory}/`);
const info = document => ({ path: document.path, url: document.url, digest: document.digest });

export async function inspectSkillCandidate(snapshot, skillFile) {
  const directory = path.posix.dirname(skillFile) === '.' ? '' : path.posix.dirname(skillFile);
  const document = await snapshot.read(skillFile);
  const metadata = inspectSkillDescription(document.content, path.posix.basename(directory));
  const related = snapshot.files.filter(file => inDirectory(file.path, directory));
  const notes = [...metadata.issues];
  const parentDirectories = ancestors(directory);
  const licenseFile = parentDirectories.flatMap(parent => snapshot.files.filter(file => path.posix.dirname(file.path) === (parent || '.') && LICENSE.test(path.posix.basename(file.path))).sort((a, b) => a.path.localeCompare(b.path)))[0];
  let license = { status: metadata.licenseDeclaration ? 'declared' : 'unknown', declaration: metadata.licenseDeclaration,
    identifier: 'unknown', scope: 'unknown', document: null };
  if (licenseFile) {
    try {
      const data = await snapshot.read(licenseFile.path);
      license = { ...license, status: 'document-found', scope: path.posix.dirname(licenseFile.path) === directory ? 'skill' : 'ancestor',
        identifier: data.content.match(/SPDX-License-Identifier:\s*([\w.+-]+)/)?.[1] || 'unknown',
        document: { ...info(data), excerpt: data.content.slice(0, 4000), truncated: data.content.length > 4000 }, applicability: 'unverified' };
    } catch (error) {
      if (['SKILL_DISCOVERY_CANCELLED', 'SKILL_DISCOVERY_TIMEOUT', 'SKILL_DISCOVERY_REQUEST_LIMIT'].includes(error.code)) throw error;
      notes.push(`license-read:${error.code || 'failed'}`);
    }
  }
  const manifests = related.filter(file => MANIFEST.test(path.posix.basename(file.path))).sort((a, b) => a.path.localeCompare(b.path));
  const dependencies = [];
  for (const file of manifests.slice(0, 2)) {
    try {
      const data = await snapshot.read(file.path);
      const entry = { ...info(data), status: 'declared', format: path.posix.basename(file.path), declarations: [], excerpt: data.content.slice(0, 4000), truncated: data.content.length > 4000 };
      if (entry.format === 'package.json') {
        try {
          const manifest = JSON.parse(data.content);
          for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            if (manifest?.[group] && typeof manifest[group] === 'object' && !Array.isArray(manifest[group])) {
              for (const [name, version] of Object.entries(manifest[group]).slice(0, 100)) {
                if (typeof version === 'string') entry.declarations.push({ group, name: name.slice(0, 200), version: version.slice(0, 300) });
              }
            }
          }
          entry.scriptNames = manifest?.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts) ? Object.keys(manifest.scripts).slice(0, 100) : [];
        } catch { entry.status = 'unknown'; notes.push('invalid-package-json'); }
      }
      dependencies.push(entry);
    } catch (error) {
      if (['SKILL_DISCOVERY_CANCELLED', 'SKILL_DISCOVERY_TIMEOUT', 'SKILL_DISCOVERY_REQUEST_LIMIT'].includes(error.code)) throw error;
      notes.push(`dependency-read:${error.code || 'failed'}`);
    }
  }
  const scripts = related.filter(file => file.path.includes('/scripts/') || /\.(?:py|sh|bash|js|mjs|cjs|ps1)$/.test(file.path));
  const companionFiles = snapshot.files.filter(file => COMPANION.test(file.path) && parentDirectories.some(parent =>
    file.path === `${parent ? `${parent}/` : ''}${path.posix.basename(file.path)}`
    || file.path === `${parent ? `${parent}/` : ''}.codex-plugin/plugin.json`
    || file.path === `${parent ? `${parent}/` : ''}.claude-plugin/plugin.json`)).map(file => file.path);
  return { id: createHash('sha256').update(`${snapshot.repository}@${snapshot.commit}:${skillFile}`).digest('hex').slice(0, 32),
    ...metadata, displayName: metadata.name || path.posix.basename(directory) || snapshot.repository,
    source: { repository: snapshot.repository, requestedRef: snapshot.ref, commit: snapshot.commit, path: directory, skillPath: skillFile,
      url: document.url, digest: document.digest },
    license, dependencies: { status: dependencies.length ? 'declared' : 'unknown', documents: dependencies,
      manifestPaths: manifests.slice(0, 50).map(file => file.path), totalManifests: manifests.length, inspectedManifests: dependencies.length, complete: manifests.length <= 2 && dependencies.length === manifests.length },
    scripts: { paths: scripts.slice(0, 50).map(file => file.path), total: scripts.length, contentsInspected: false },
    companionFiles: companionFiles.slice(0, 50),
    preview: { content: document.content.slice(0, 6000), truncated: document.content.length > 6000, untrusted: true },
    issues: notes, installation: { state: 'not-installed-by-discovery', requiresUserSelection: true }, untrusted: true };
}

const STAGE_TERMS = Object.freeze({ direction: ['research', 'question', 'survey', '调研', '方向'], search: ['search', 'literature', 'paper', '检索', '文献', '论文'],
  selection: ['review', 'citation', 'reader', 'pdf', '阅读', '筛选'], replication: ['reproduce', 'data', 'notebook', '复现', '数据'],
  ideation: ['hypothesis', 'innovation', 'analysis', '创新', '假设'], method: ['method', 'design', '方法', '设计'],
  experiment: ['experiment', 'benchmark', 'test', '实验', '验证'], writing: ['writing', 'document', 'citation', 'latex', 'pdf', '写作', '论文'] });
export function discoveryTerms(query = '', stage = null) {
  const direct = query.toLowerCase().split(/[\s,，。;；/]+/).filter(Boolean).slice(0, 24);
  const expanded = Object.values(STAGE_TERMS).flatMap(terms => terms.some(term => direct.some(word => word.includes(term))) ? terms : []);
  return [...new Set([...direct, ...(STAGE_TERMS[stage] || []), ...expanded])].slice(0, 64);
}
export function matchResearchPurpose(candidate, query, stage) {
  const text = `${candidate.displayName} ${candidate.description || ''} ${candidate.source?.path || ''}`.toLowerCase();
  const matchedTerms = discoveryTerms(query, stage).filter(term => text.includes(term));
  const declaredStage = Boolean(stage && candidate.stages?.includes(stage));
  return { method: 'deterministic-keywords', query, stage, matchedTerms, declaredStage,
    score: matchedTerms.length + (declaredStage ? 3 : 0), runtimeVerified: false,
    explanation: declaredStage ? '发布者声明适用于此阶段；尚未验证实际效果。' : matchedTerms.length ? '名称或说明命中了研究任务关键词；尚未验证实际效果。' : '没有明确的研究任务关键词匹配。' };
}
