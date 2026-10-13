import { applyPatch, createTwoFilesPatch } from 'diff';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { safeJoin } from '../utils/pathUtils.js';
import { extractPathFromPatch } from '../utils/diffUtils.js';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from './llmService.js';
import { getProjectRoot } from './projectService.js';
import { extractArxivId, fetchArxivEntry, buildArxivBibtex } from './arxivService.js';
import { t } from '../i18n/index.js';
import { assertCapability, assertNetworkHost, assertProjectPath, capabilityForToolName, hasCapability, isPathAllowed, DEFAULT_PROJECT_CAPABILITIES } from './harnessRuntime/capabilities.js';
import { createLegacyToolPolicy } from './harnessRuntime/legacyToolPolicy.js';
import { readEnabledResearchSkillDocument } from './researchResearch/researchSkills.js';
import { formatHarnessInput } from './harnessRuntime/contextPackager.js';
import { readFileState, sameVersion } from './harnessRuntime/fileVersions.js';
import { HarnessRuntimeError } from './harnessRuntime/errors.js';
import { searchProjectPapers } from './paperSearch.js';
import { searchSessionCandidates } from './researchSources/candidateIdentity.js';

export function createArxivSearchTool({ projectId, capabilityPolicy, signal, search = searchProjectPapers, makeTool = fields => new DynamicStructuredTool(fields) }) {
  return makeTool({
    name: 'arxiv_search',
    description: 'Search arXiv through the project paper search. Returns papers and a saved searchSessionId. Input: { query, maxResults? }.',
    schema: z.object({ query: z.string().min(1).max(2000), maxResults: z.number().finite().nullish() }).strict(),
    func: async ({ query, maxResults }, { recheck } = {}) => {
      assertCapability(capabilityPolicy, 'research.search');
      assertNetworkHost(capabilityPolicy, 'https://export.arxiv.org/api/query');
      signal?.throwIfAborted();
      const session = await search(projectId, { query, sources: ['arxiv'], pageSize: Math.min(10, Math.max(1, Math.floor(maxResults || 5))) }, {
        signal,
        ...(recheck ? { beforeRequest: ({ url }) => recheck({ url }), beforePersist: () => recheck() } : {})
      });
      signal?.throwIfAborted();
      return JSON.stringify({ papers: searchSessionCandidates(session), searchSessionId: session.id, status: session.status, failures: session.failures });
    }
  });
}

/**
 * Builds the tool-agent model.
 *
 * Exported so the Run's token budget is testable without a network call: the
 * Harness Runtime computes `limits.maxTokens`, and C-10 requires that the legacy
 * path actually applies it rather than ignoring it.
 */
export function buildToolAgentModel({ llmConfig, limits } = {}) {
  const resolved = resolveLLMConfig(llmConfig);
  const maxTokens = Number(limits?.maxTokens);
  return {
    resolved,
    model: new ChatOpenAI({
      model: resolved.model,
      temperature: 0.2,
      apiKey: resolved.apiKey,
      openAIApiKey: resolved.apiKey,
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      configuration: { baseURL: normalizeBaseURL(normalizeChatEndpoint(resolved.endpoint)) }
    })
  };
}

/** Collect provider-reported usage across every model turn in a tool-agent Run. */
export function createLLMUsageTracker() {
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let reported = false;
  const callback = BaseCallbackHandler.fromMethods({
    handleLLMEnd(result) {
      const tokens = result?.llmOutput?.tokenUsage;
      if (!tokens || ![tokens.promptTokens, tokens.completionTokens, tokens.totalTokens]
        .some((value) => Number.isFinite(value) && value >= 0)) return;
      reported = true;
      for (const key of Object.keys(usage)) {
        if (Number.isFinite(tokens[key]) && tokens[key] >= 0) usage[key] += tokens[key];
      }
    }
  });
  callback.awaitHandlers = true;
  return { callback, getUsage: () => reported ? { ...usage } : null };
}

export async function runToolAgent({
  projectId,
  activePath,
  task,
  prompt,
  humanInstructions,
  selection,
  compileLog,
  contextPack,
  source,
  researchSkills = [],
  llmConfig,
  limits,
  lang = 'zh-CN',
  capabilities = DEFAULT_PROJECT_CAPABILITIES,
  capabilityPolicy,
  readPolicy,
  onDecision,
  signal,
  emit = () => {},
  modelFactory = buildToolAgentModel
}) {
  signal?.throwIfAborted();
  if (!projectId) {
    return { ok: false, reply: t(lang, 'missing_project_id_tools'), patches: [] };
  }

  const projectRoot = await getProjectRoot(projectId);
  const pendingPatches = [];
  const effectiveCapabilityPolicy = capabilityPolicy || { granted: capabilities };
  const policy = readPolicy || onDecision ? await createLegacyToolPolicy({ projectId, task, capabilityPolicy: effectiveCapabilityPolicy, readPolicy, onDecision, signal }) : null;
  // Production enters through legacyAdapter, which requires both callbacks.
  // Standalone callers are retained for deterministic provider contract tests.
  const makeTool = ({ func, ...fields }) => new DynamicStructuredTool({
    ...fields,
    func: async (args, manager) => {
      const filePath = fields.name === 'list_files' ? args.dir || ''
        : fields.name === 'apply_patch' ? args.path || extractPathFromPatch(args.patch)
          : ['read_file', 'propose_patch'].includes(fields.name) ? args.path : undefined;
      const admission = await policy?.admit({ tool: fields.name, callId: manager?.runId, ...(filePath !== undefined ? { path: filePath } : {}) });
      const recheck = admission?.recheck || (async () => { signal?.throwIfAborted(); return effectiveCapabilityPolicy; });
      try {
        emit({ type: 'tool/start', data: { name: fields.name, callId: manager?.runId, arguments: JSON.stringify(args) } });
        await recheck();
        const result = await func(args, { recheck });
        await recheck();
        return result;
      } catch (reason) {
        await admission?.deny(reason);
        throw reason;
      }
    }
  });
  const readVersions = new Map((contextPack?.files || []).map((file) => [file.path, { exists: true, sha256: file.sha256 }]));
  const readSnapshot = async (filePath, { requireRead = false, recheck } = {}) => {
    signal?.throwIfAborted();
    await recheck?.({ path: filePath });
    const state = await readFileState(projectRoot, filePath);
    await recheck?.({ path: filePath });
    signal?.throwIfAborted();
    const previous = readVersions.get(filePath);
    if (previous && !sameVersion(previous, state)) {
      throw new HarnessRuntimeError(409, 'DOCUMENT_VERSION_CONFLICT', 'A file changed after the assistant read it.', { path: filePath });
    }
    if (requireRead && state.exists && !previous) {
      throw new HarnessRuntimeError(409, 'PATCH_REQUIRES_READ', 'Read the file before proposing a replacement.', { path: filePath });
    }
    const version = { exists: state.exists, sha256: state.sha256 };
    readVersions.set(filePath, version);
    emit({ type: 'file/read', data: { path: filePath, version } });
    return state;
  };
  const recordPatch = (patch) => {
    const index = pendingPatches.findIndex((item) => item.path === patch.path);
    if (index < 0) pendingPatches.push(patch);
    else pendingPatches[index] = patch;
  };

  const readFileTool = makeTool({
    name: 'read_file',
    description: 'Read a UTF-8 file from the project. Input: { path } (relative to project root).',
    schema: z.object({ path: z.string().min(1).max(1024) }).strict(),
    func: async ({ path: filePath }, { recheck }) => {
      const safePath = assertProjectPath(filePath, effectiveCapabilityPolicy, { operation: 'read' });
      const state = await readSnapshot(safePath, { recheck });
      if (!state.exists) throw Object.assign(new Error(`ENOENT: file not found: ${safePath}`), { code: 'ENOENT' });
      return state.content.slice(0, 20000);
    }
  });

  const listFilesTool = makeTool({
    name: 'list_files',
    description: 'List files under a directory. Input: { dir } (relative path, optional).',
    schema: z.object({ dir: z.string().max(1024).nullish() }).strict(),
    func: async ({ dir }, { recheck }) => {
      const safePath = assertProjectPath(dir || '', effectiveCapabilityPolicy, { operation: 'read' });
      const root = safePath ? safeJoin(projectRoot, safePath) : projectRoot;
      const files = [];
      const visit = async relative => {
        const current = await recheck({ path: safePath });
        const directory = relative ? safeJoin(root, relative) : root;
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const item = path.posix.join(relative, entry.name);
          const projectPath = path.posix.join(safePath, item);
          if (entry.name === 'project.json' || entry.name === '.compile' || entry.isSymbolicLink()
            || !isPathAllowed(projectPath, effectiveCapabilityPolicy) || !isPathAllowed(projectPath, current)) continue;
          if (entry.isDirectory()) await visit(item);
          else if (entry.isFile()) files.push(item);
        }
      };
      await visit('');
      await recheck({ path: safePath });
      return JSON.stringify({ files });
    }
  });

  const proposePatchTool = makeTool({
    name: 'propose_patch',
    description: 'Propose a full file rewrite. Input: { path, content }. This does NOT write. It returns a patch for user confirmation.',
    schema: z.object({ path: z.string().min(1).max(1024), content: z.string().max(1_048_576) }).strict(),
    func: async ({ path: filePath, content }, { recheck }) => {
      const safePath = assertProjectPath(filePath, effectiveCapabilityPolicy, { operation: 'patch' });
      const state = await readSnapshot(safePath, { requireRead: true, recheck });
      const original = state.content;
      if (state.exists && content === original) return 'No changes proposed: content is identical to the current file. Provide corrected content if an edit is needed.';
      const diff = createTwoFilesPatch(safePath, safePath, original, content, 'current', 'proposed');
      await recheck({ path: safePath });
      recordPatch({ path: safePath, original, content, diff, baseVersion: { exists: state.exists, sha256: state.sha256 } });
      return `Patch prepared for ${safePath}. Awaiting user confirmation.`;
    }
  });

  const applyPatchTool = makeTool({
    name: 'apply_patch',
    description: 'Apply a unified diff to a file and propose changes. Input: { patch, path? }. This does NOT write.',
    schema: z.object({ patch: z.string().max(1_048_576), path: z.string().min(1).max(1024).nullish() }).strict(),
    func: async ({ patch, path: providedPath }, { recheck }) => {
      const filePath = providedPath || extractPathFromPatch(patch);
      if (!filePath) {
        throw new Error('Patch missing file path');
      }
      const safePath = assertProjectPath(filePath, effectiveCapabilityPolicy, { operation: 'patch' });
      const state = await readSnapshot(safePath, { requireRead: true, recheck });
      const original = state.content;
      const patched = applyPatch(original, patch);
      if (patched === false) {
        throw new Error('Failed to apply patch');
      }
      if (patched === original) return 'No changes proposed: the patch did not change the file. Use a unified diff with ---/+++ file headers and numbered @@ -old,count +new,count @@ hunks, or use propose_patch with corrected full content. Begin Patch/Update File markers are not supported.';
      const diff = createTwoFilesPatch(safePath, safePath, original, patched, 'current', 'proposed');
      await recheck({ path: safePath });
      recordPatch({ path: safePath, original, content: patched, diff, baseVersion: { exists: state.exists, sha256: state.sha256 } });
      return `Patch applied in memory for ${safePath}. Awaiting user confirmation.`;
    }
  });

  const compileLogTool = makeTool({
    name: 'get_compile_log',
    description: 'Return the latest compile log from the client (read-only). Input: { }.',
    schema: z.object({}).strict(),
    func: async () => {
      assertCapability(effectiveCapabilityPolicy, 'project.read');
      return compileLog || 'No compile log provided.';
    }
  });

  const arxivSearchTool = createArxivSearchTool({ projectId, capabilityPolicy: effectiveCapabilityPolicy, signal, makeTool });

  const arxivBibtexTool = makeTool({
    name: 'arxiv_bibtex',
    description: 'Generate BibTeX for an arXiv paper. Input: { arxivId }.',
    schema: z.object({ arxivId: z.string().min(1).max(512) }).strict(),
    func: async ({ arxivId }, { recheck }) => {
      assertCapability(effectiveCapabilityPolicy, 'research.search');
      const id = extractArxivId(arxivId);
      if (!id) throw new Error('Invalid arXiv ID');
      assertNetworkHost(effectiveCapabilityPolicy, `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
      const entry = await fetchArxivEntry(id, { signal, beforeRequest: ({ url }) => recheck({ url }) });
      if (!entry) throw new Error('No arXiv metadata found');
      return buildArxivBibtex(entry);
    }
  });

  const enabledResearchSkills = [...new Set((Array.isArray(researchSkills) ? researchSkills : []).filter((name) => typeof name === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)))];
  const readResearchSkillTool = makeTool({
    name: 'read_research_skill',
    description: 'Read the instructions for a research Skill enabled in this Run. Input: { name, file? }. Start with SKILL.md; optionally read its referenced Markdown files.',
    schema: z.object({ name: z.string().min(1).max(120), file: z.string().max(1024).nullish() }).strict(),
    func: async ({ name, file }, { recheck }) => {
      assertCapability(effectiveCapabilityPolicy, 'project.read');
      const current = await recheck();
      return readEnabledResearchSkillDocument({ projectId, enabledSkillNames: enabledResearchSkills, name, file, capabilityPolicy: current });
    }
  });

  const { resolved, model: llm } = modelFactory({ llmConfig, limits });
  if (!resolved.apiKey) {
    return { ok: false, reply: 'SCIENCEPRISM_LLM_API_KEY not set', patches: [] };
  }

  const tools = [readFileTool, listFilesTool, proposePatchTool, applyPatchTool, compileLogTool, arxivSearchTool, arxivBibtexTool, ...(enabledResearchSkills.length ? [readResearchSkillTool] : [])]
    .filter((tool) => hasCapability(effectiveCapabilityPolicy, capabilityForToolName(tool.name)));

  const system = [
    'You are a LaTeX paper assistant for SciencePrism.',
    'You can read files and propose patches via tools, and you may call tools multiple times.',
    'If a request affects multiple files (e.g., sections + bib), inspect and update all relevant files.',
    hasCapability(effectiveCapabilityPolicy, 'research.search') ? 'You can use arxiv_search to find papers and arxiv_bibtex to generate BibTeX.' : '',
    'Never assume writes are applied; use propose_patch and wait for user confirmation.',
    'Use apply_patch for localized edits; use propose_patch for full-file rewrites.',
    enabledResearchSkills.length ? `Research Skills enabled for this Run: ${enabledResearchSkills.join(', ')}. Read each relevant SKILL.md with read_research_skill before producing the stage output; follow its references only when needed.` : '',
    'Be concise. Provide a short summary in the final response.'
    , source === 'editor' ? 'Use tools for edits: never put replacement file content only in the final reply. Return a final JSON object with reply and constraintProposal (null unless the user requests a durable rule). Supported rules: reply.forbid_text, patch.forbid_text, patch.forbid_path, with kind, value, statement. A rule is a proposal until human acceptance; never claim it is active.' : ''
  ].filter(Boolean).join(' ');

  const userInput = formatHarnessInput({ task, activePath, prompt, humanInstructions, selection, compileLog, contextPack });

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ['system', system],
    ['human', '{input}'],
    new MessagesPlaceholder('agent_scratchpad')
  ]);

  const agent = await createOpenAIToolsAgent({ llm, tools, prompt: promptTemplate });
  const executor = new AgentExecutor({ agent, tools, handleToolRuntimeErrors: (error) => { throw error; } });
  const usageTracker = createLLMUsageTracker();
  const toolEvents = BaseCallbackHandler.fromMethods({
    handleToolStart(_tool, input, callId, _parentId, _tags, _metadata, name) {
      signal?.throwIfAborted();
      assertCapability(effectiveCapabilityPolicy, capabilityForToolName(name));
      signal?.throwIfAborted();
    },
    handleToolEnd(output, callId) {
      emit({ type: 'tool/end', data: { callId, output } });
    },
    handleToolError(error, callId) {
      emit({ type: 'tool/error', data: { callId, error: { message: error?.message, code: error?.code } } });
    }
  });
  toolEvents.raiseError = true;
  toolEvents.awaitHandlers = true;
  const result = await executor.invoke({ input: userInput }, { signal, callbacks: [usageTracker.callback, toolEvents] });
  signal?.throwIfAborted();

  return {
    ok: true,
    reply: result.output || '',
    patches: pendingPatches,
    usage: usageTracker.getUsage()
  };
}
