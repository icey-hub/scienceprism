import { promises as fs } from 'node:fs';
import os, { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { getProjectRoot } from './projectService.js';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from './llmService.js';
import { safeJoin } from '../utils/pathUtils.js';
import {
  copyBundledResearchSkills,
  isBundledSkillPath,
  restrictWorkspaceResearchSkills
} from './researchResearch/researchSkills.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PATCH_FILE_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.agent_runs', '.cache']);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function collectFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'project.json' || entry.name === '.compile') continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, child));
    } else if (entry.isFile()) {
      files.push(toPosix(child));
    }
  }
  return files;
}

async function copyWorkspace(sourceRoot, targetRoot) {
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      if (IGNORED_DIRS.has(name)) return false;
      if (name === 'project.json' || name === '.compile') return false;
      return true;
    }
  });
}

async function readTextFile(root, relativePath) {
  const absolute = safeJoin(root, relativePath);
  const stat = await fs.stat(absolute);
  if (stat.size > MAX_PATCH_FILE_BYTES) return null;
  return fs.readFile(absolute, 'utf8');
}

async function collectPatches(originalRoot, workspaceRoot, excludedPaths = []) {
  const originalFiles = await collectFiles(originalRoot);
  const workspaceFiles = await collectFiles(workspaceRoot);
  const originalSet = new Set(originalFiles);
  const workspaceSet = new Set(workspaceFiles);
  const allPaths = [...new Set([...originalFiles, ...workspaceFiles])]
    .filter((relativePath) => !isBundledSkillPath(relativePath, excludedPaths))
    .sort();
  const patches = [];

  for (const relativePath of allPaths) {
    const original = originalSet.has(relativePath) ? await readTextFile(originalRoot, relativePath) : '';
    const proposed = workspaceSet.has(relativePath) ? await readTextFile(workspaceRoot, relativePath) : '';
    if (original === null || proposed === null || original === proposed) continue;
    patches.push({
      path: relativePath,
      original,
      content: proposed,
      deleted: !workspaceSet.has(relativePath),
      diff: createTwoFilesPatch(relativePath, relativePath, original, proposed, 'current', 'proposed')
    });
  }
  return patches;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadHarnessSdk() {
  const candidates = [];
  if (process.env.OPENPRISM_HARNESS_SDK) candidates.push(process.env.OPENPRISM_HARNESS_SDK);
  candidates.push(path.join(homedir(), 'Desktop/DeepSeek Harness/deepseek-harness/packages/sdk/client/lib/index.js'));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return import(pathToFileURL(candidate).href);
  }

  try {
    return await import('@deepseek-ai/dsh-sdk-client');
  } catch {
    throw new Error(
      'DeepSeek Harness SDK not found. Set OPENPRISM_HARNESS_SDK to packages/sdk/client/lib/index.js.'
    );
  }
}

function eventSummary(events = []) {
  return events
    .filter((event) => ['tool/call', 'tool/result', 'assistant/message'].includes(event?.type))
    .map((event) => ({
      type: event.type,
      name: event.data?.name,
      callId: event.data?.callId,
      text: event.type === 'assistant/message'
        ? event.data?.message?.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        : undefined
    }));
}

function eventFailure(events = []) {
  const terminal = [...events].reverse().find((event) => event?.type === 'turn/end');
  if (terminal?.data?.reason?.kind !== 'error') return '';
  return terminal.data.reason.error?.message || terminal.data.reason.error?.code || 'agent turn failed';
}

export async function runDeepSeekHarness({
  projectId,
  activePath,
  task,
  prompt,
  selection,
  compileLog,
  llmConfig,
  researchSkills
}) {
  if (!projectId) {
    return { ok: false, reply: 'Missing project id.', patches: [], runtime: 'deepseek-harness' };
  }

  const projectRoot = await getProjectRoot(projectId);
  const resolved = resolveLLMConfig(llmConfig);
  const timeoutMs = Number(process.env.OPENPRISM_HARNESS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openprism-harness-'));
  const workspace = path.join(runRoot, 'workspace');
  const dshHome = path.join(runRoot, 'dsh-home');
  let harness;

  try {
    await copyWorkspace(projectRoot, workspace);
    const hasResearchSkillScope = Array.isArray(researchSkills);
    const removedSkillPaths = hasResearchSkillScope
      ? await restrictWorkspaceResearchSkills(workspace, { enabledSkillNames: researchSkills })
      : [];
    const bundledSkillPaths = hasResearchSkillScope
      ? await copyBundledResearchSkills(workspace, { enabledSkillNames: researchSkills })
      : [];
    const { DeepSeekHarness } = await loadHarnessSdk();
    const configuredEndpoint = typeof llmConfig?.endpoint === 'string' && llmConfig.endpoint.trim()
      ? llmConfig.endpoint.trim()
      : (process.env.OPENPRISM_LLM_ENDPOINT || '').trim();
    const defaultEndpoint = normalizeChatEndpoint(undefined);
    const configuredBaseUrl = normalizeBaseURL(normalizeChatEndpoint(resolved.endpoint));
    const inheritedBaseUrl = (process.env.DEEPSEEK_BASE_URL || '').trim();
    const baseUrl = !configuredEndpoint || configuredEndpoint === defaultEndpoint
      ? (inheritedBaseUrl || undefined)
      : configuredBaseUrl;
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: resolved.apiKey || process.env.DEEPSEEK_API_KEY || '',
      ...(baseUrl ? { DEEPSEEK_BASE_URL: baseUrl } : {})
    };
    if (!env.DEEPSEEK_API_KEY) {
      return { ok: false, reply: 'DeepSeek API key is not configured.', patches: [], runtime: 'deepseek-harness' };
    }

    harness = new DeepSeekHarness({
      profile: process.env.OPENPRISM_HARNESS_PROFILE || 'sdk',
      ...(process.env.OPENPRISM_HARNESS_DSH_BIN ? { dshBin: process.env.OPENPRISM_HARNESS_DSH_BIN } : {}),
      cwd: workspace,
      processCwd: workspace,
      dshHome,
      provider: process.env.OPENPRISM_HARNESS_PROVIDER || 'deepseek-official',
      model: resolved.model || process.env.DEEPSEEK_MODEL || 'deepseek-flash',
      maxTokens: Number(process.env.OPENPRISM_HARNESS_MAX_TOKENS || 49152),
      env,
      requestTimeoutMs: timeoutMs,
      initializeTimeoutMs: Math.min(timeoutMs, 30_000)
    });

    const input = [
      `Task: ${task || 'polish'}`,
      activePath ? `Active file: ${activePath}` : '',
      prompt ? `User prompt: ${prompt}` : '',
      selection ? `Selection:\n${selection}` : '',
      compileLog ? `Compile log:\n${compileLog}` : '',
      'Work inside the provided workspace. Make only the changes needed for the request.'
    ].filter(Boolean).join('\n\n');
    const sessionId = `openprism-${projectId}-${randomUUID()}`;
    const result = await harness.run(input, { sessionId });
    const patches = await collectPatches(projectRoot, workspace, [...bundledSkillPaths, ...removedSkillPaths]);
    const failure = eventFailure(result.events);
    if (failure) {
      return {
        ok: false,
        reply: `DeepSeek Harness failed: ${failure}`,
        patches,
        runtime: 'deepseek-harness',
        sessionId: result.sessionId,
        events: eventSummary(result.events)
      };
    }
    return {
      ok: true,
      reply: result.finalResponse || '',
      patches,
      runtime: 'deepseek-harness',
      sessionId: result.sessionId,
      events: eventSummary(result.events)
    };
  } catch (error) {
    return {
      ok: false,
      reply: `DeepSeek Harness unavailable: ${error instanceof Error ? error.message : String(error)}`,
      patches: [],
      runtime: 'deepseek-harness'
    };
  } finally {
    if (harness) await harness.close().catch(() => {});
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}
