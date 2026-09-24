import { promises as fs } from 'fs';
import { applyPatch, createTwoFilesPatch } from 'diff';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { safeJoin } from '../utils/pathUtils.js';
import { listFilesRecursive } from '../utils/fsUtils.js';
import { extractPathFromPatch } from '../utils/diffUtils.js';
import { resolveLLMConfig, normalizeBaseURL, normalizeChatEndpoint } from './llmService.js';
import { getProjectRoot } from './projectService.js';
import { extractArxivId, fetchArxivEntry, buildArxivBibtex } from './arxivService.js';
import { t } from '../i18n/index.js';
import { assertCapability, assertNetworkHost, assertProjectPath, DEFAULT_PROJECT_CAPABILITIES } from './harnessRuntime/capabilities.js';

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

export async function runToolAgent({
  projectId,
  activePath,
  task,
  prompt,
  selection,
  compileLog,
  contextPack,
  llmConfig,
  limits,
  lang = 'zh-CN',
  capabilities = DEFAULT_PROJECT_CAPABILITIES,
  capabilityPolicy
}) {
  if (!projectId) {
    return { ok: false, reply: t(lang, 'missing_project_id_tools'), patches: [] };
  }

  const projectRoot = await getProjectRoot(projectId);
  const pendingPatches = [];
  const effectiveCapabilityPolicy = capabilityPolicy || { granted: capabilities };

  const readFileTool = new DynamicStructuredTool({
    name: 'read_file',
    description: 'Read a UTF-8 file from the project. Input: { path } (relative to project root).',
    schema: z.object({ path: z.string() }),
    func: async ({ path: filePath }) => {
      const safePath = assertProjectPath(filePath, effectiveCapabilityPolicy, { operation: 'read' });
      const abs = safeJoin(projectRoot, safePath);
      const content = await fs.readFile(abs, 'utf8');
      return content.slice(0, 20000);
    }
  });

  const listFilesTool = new DynamicStructuredTool({
    name: 'list_files',
    description: 'List files under a directory. Input: { dir } (relative path, optional).',
    schema: z.object({ dir: z.string().optional() }),
    func: async ({ dir }) => {
      const safePath = assertProjectPath(dir || '', effectiveCapabilityPolicy, { operation: 'read' });
      const root = safePath ? safeJoin(projectRoot, safePath) : projectRoot;
      const items = await listFilesRecursive(root, '');
      const files = items.filter((item) => item.type === 'file').map((item) => item.path);
      return JSON.stringify({ files });
    }
  });

  const proposePatchTool = new DynamicStructuredTool({
    name: 'propose_patch',
    description: 'Propose a full file rewrite. Input: { path, content }. This does NOT write. It returns a patch for user confirmation.',
    schema: z.object({ path: z.string(), content: z.string() }),
    func: async ({ path: filePath, content }) => {
      const safePath = assertProjectPath(filePath, effectiveCapabilityPolicy, { operation: 'patch' });
      let original = '';
      try {
        const abs = safeJoin(projectRoot, safePath);
        original = await fs.readFile(abs, 'utf8');
      } catch {
        original = '';
      }
      const diff = createTwoFilesPatch(safePath, safePath, original, content, 'current', 'proposed');
      pendingPatches.push({ path: safePath, original, content, diff });
      return `Patch prepared for ${safePath}. Awaiting user confirmation.`;
    }
  });

  const applyPatchTool = new DynamicStructuredTool({
    name: 'apply_patch',
    description: 'Apply a unified diff to a file and propose changes. Input: { patch, path? }. This does NOT write.',
    schema: z.object({ patch: z.string(), path: z.string().optional() }),
    func: async ({ patch, path: providedPath }) => {
      const filePath = providedPath || extractPathFromPatch(patch);
      if (!filePath) {
        throw new Error('Patch missing file path');
      }
      const safePath = assertProjectPath(filePath, effectiveCapabilityPolicy, { operation: 'patch' });
      const abs = safeJoin(projectRoot, safePath);
      const original = await fs.readFile(abs, 'utf8');
      const patched = applyPatch(original, patch);
      if (patched === false) {
        throw new Error('Failed to apply patch');
      }
      const diff = createTwoFilesPatch(safePath, safePath, original, patched, 'current', 'proposed');
      pendingPatches.push({ path: safePath, original, content: patched, diff });
      return `Patch applied in memory for ${safePath}. Awaiting user confirmation.`;
    }
  });

  const compileLogTool = new DynamicStructuredTool({
    name: 'get_compile_log',
    description: 'Return the latest compile log from the client (read-only). Input: { }.',
    schema: z.object({}),
    func: async () => {
      return compileLog || 'No compile log provided.';
    }
  });

  const arxivSearchTool = new DynamicStructuredTool({
    name: 'arxiv_search',
    description: 'Search arXiv papers. Input: { query, maxResults? }.',
    schema: z.object({ query: z.string(), maxResults: z.number().optional() }),
    func: async ({ query, maxResults }) => {
      assertCapability(effectiveCapabilityPolicy, 'research.search');
      const max = Math.min(10, Math.max(1, maxResults || 5));
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}`;
      assertNetworkHost(effectiveCapabilityPolicy, url);
      const res = await fetch(url, { headers: { 'User-Agent': 'scienceprism/1.0' } });
      if (!res.ok) {
        throw new Error(`arXiv search failed: ${res.status}`);
      }
      const xml = await res.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const data = parser.parse(xml);
      const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : data?.feed?.entry ? [data.feed.entry] : [];
      const papers = entries.map((entry) => {
        const authors = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
        const authorNames = authors.map((a) => a?.name).filter(Boolean);
        const id = String(entry.id || '');
        const arxivId = id ? id.split('/').pop() : '';
        return {
          title: String(entry.title || '').replace(/\s+/g, ' ').trim(),
          abstract: String(entry.summary || '').replace(/\s+/g, ' ').trim(),
          authors: authorNames,
          url: id,
          arxivId
        };
      });
      return JSON.stringify({ papers });
    }
  });

  const arxivBibtexTool = new DynamicStructuredTool({
    name: 'arxiv_bibtex',
    description: 'Generate BibTeX for an arXiv paper. Input: { arxivId }.',
    schema: z.object({ arxivId: z.string() }),
    func: async ({ arxivId }) => {
      assertCapability(effectiveCapabilityPolicy, 'research.search');
      const id = extractArxivId(arxivId);
      if (!id) throw new Error('Invalid arXiv ID');
      assertNetworkHost(effectiveCapabilityPolicy, `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
      const entry = await fetchArxivEntry(id);
      if (!entry) throw new Error('No arXiv metadata found');
      return buildArxivBibtex(entry);
    }
  });

  const { resolved, model: llm } = buildToolAgentModel({ llmConfig, limits });
  if (!resolved.apiKey) {
    return { ok: false, reply: 'SCIENCEPRISM_LLM_API_KEY not set', patches: [] };
  }

  const system = [
    'You are a LaTeX paper assistant for SciencePrism.',
    'You can read files and propose patches via tools, and you may call tools multiple times.',
    'If a request affects multiple files (e.g., sections + bib), inspect and update all relevant files.',
    'You can use arxiv_search to find papers and arxiv_bibtex to generate BibTeX.',
    'Never assume writes are applied; use propose_patch and wait for user confirmation.',
    'Use apply_patch for localized edits; use propose_patch for full-file rewrites.',
    'Be concise. Provide a short summary in the final response.'
  ].join(' ');

  const userInput = [
    `Task: ${task || 'polish'}`,
    activePath ? `Active file: ${activePath}` : '',
    prompt ? `User prompt: ${prompt}` : '',
    selection ? `Selection:\n${selection}` : '',
    compileLog ? `Compile log:\n${compileLog}` : '',
    contextPack ? `Structured context pack (authoritative snapshot):\n${JSON.stringify(contextPack)}` : ''
  ].filter(Boolean).join('\n\n');

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ['system', system],
    ['human', '{input}'],
    new MessagesPlaceholder('agent_scratchpad')
  ]);

  const tools = [readFileTool, listFilesTool, proposePatchTool, applyPatchTool, compileLogTool, arxivSearchTool, arxivBibtexTool];
  const agent = await createOpenAIToolsAgent({ llm, tools, prompt: promptTemplate });
  const executor = new AgentExecutor({ agent, tools });
  const result = await executor.invoke({ input: userInput });

  return {
    ok: true,
    reply: result.output || '',
    patches: pendingPatches
  };
}
