import { CollaborationPanel } from './editor/CollaborationPanel';
import { VisionPanel } from './editor/VisionPanel';
import { LiteratureSearchPanel } from './editor/LiteratureSearchPanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, DragEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { searchKeymap } from '@codemirror/search';
import { toggleComment } from '@codemirror/commands';
import { setDiagnostics } from '@codemirror/lint';
import { foldKeymap } from '@codemirror/language';
import { createFolder as createFolderApi, deleteFile, getFile, getProjectTree, listProjects, renamePath, updateFileOrder, uploadFiles, writeFile } from '../api/projectAdapter';
import { createCollabInvite, getCollabServer, getCollabToken, setCollabServer } from '../api/collaborationAdapter';
import { arxivBibtex, arxivSearch, callLLM, generateGptImage, plotFromTable, runAgent, visionToLatex } from '../api/editorAdapter';
import type { ArxivPaper } from '../api/editorAdapter';
import { createTwoFilesPatch } from 'diff';
import { useCompilation } from './editor/useCompilation';
import { PlotPanel } from './editor/PlotPanel';
import { useEditorSession } from './editor/useEditorSession';
import { editorExtensions, setGhostEffect } from './editor/editorExtensions';
import { useCollaborationSession } from './editor/useCollaborationSession';
import ResearchWorkspacePage, { type ResearchWorkspaceState } from './ResearchWorkspacePage';
import { ResearchStageNavigation } from './research/ResearchStageNavigation';
import { getResearchStage, isResearchStageId, type ResearchStageId } from './research/researchStages';
import { buildSplitDiff, SplitDiffView } from './editor/EditorDiff';
import { PdfPreview } from './editor/PdfPreview';
import { getLatexBodyInsertionRange } from './editor/latexSnippetInsertion';
import { compileDiagnostics, resolveCompileFile, type CompileError } from './editor/compileDiagnostics';
import { AssistantPanel, type AssistantIntent } from './editor/AssistantPanel';
import { useAssistantRun } from './editor/useAssistantRun';
import { useChangeReview, type PendingChange } from './editor/useChangeReview';
import { useDocumentDrafts } from './editor/useDocumentDrafts';
import type { HarnessRun } from '../api/assistantAdapter';
import { loadCollabName, loadSettings, normalizeServerUrl, persistCollabName, persistSettings } from './editor/editorSettings';
import type { AppSettings, CompileEngine } from './editor/editorSettings';
import { ProjectWorkspaceNav } from './components/ProjectWorkspaceNav';
import { researchHref } from './research/researchLocation';
import { rememberEditorFile, restoredEditorFile } from './editor/editorLocation';
import {
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  FolderTree,
  Globe2,
  Image as ImageIcon,
  Languages,
  PanelLeft,
  PanelRight,
  Play,
  Save,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Users,
  X
} from 'lucide-react';

interface WebsearchItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  bibtex: string;
  citeKey: string;
}

type InlineEdit =
  | { kind: 'new-file' | 'new-folder'; parent: string; value: string }
  | { kind: 'rename'; path: string; value: string };

const DEFAULT_TASKS = (t: (key: string) => string) => [
  { value: 'polish', label: t('润色') },
  { value: 'rewrite', label: t('改写') },
  { value: 'structure', label: t('结构调整') },
  { value: 'translate', label: t('翻译') },
  { value: 'websearch', label: t('检索 (arXiv)') },
  { value: 'custom', label: t('自定义') }
];

const RIGHT_VIEW_OPTIONS = (t: (key: string) => string) => [
  { value: 'pdf', label: 'PDF' },
  { value: 'toc', label: t('目录') },
  { value: 'figures', label: 'FIG' },
  { value: 'diff', label: 'DIFF' },
  { value: 'log', label: 'LOG' },
  { value: 'review', label: t('评审报告') }
];

const FIGURE_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps'];
const TEXT_EXTS = ['.sty', '.cls', '.bst', '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.tsv'];

function isTextPath(filePath: string) {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.tex') || lower.endsWith('.bib') || TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

function isInternalProjectPath(filePath: string) {
  return filePath === '.scienceprism' || filePath.startsWith('.scienceprism/') || filePath === '.openprism' || filePath.startsWith('.openprism/');
}

function isFigureFile(path: string) {
  const lower = path.toLowerCase();
  return FIGURE_EXTS.some((ext) => lower.endsWith(ext));
}

function isTextFile(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith('.tex') || lower.endsWith('.bib') || TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

function getFileTypeLabel(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tex')) return 'TEX';
  if (lower.endsWith('.bib')) return 'BIB';
  if (lower.endsWith('.cls')) return 'CLS';
  if (lower.endsWith('.sty')) return 'STY';
  if (lower.endsWith('.png')) return 'PNG';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'JPG';
  if (lower.endsWith('.svg')) return 'SVG';
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.txt')) return 'TXT';
  return 'FILE';
}

function getParentPath(target: string) {
  if (!target) return '';
  const idx = target.lastIndexOf('/');
  return idx === -1 ? '' : target.slice(0, idx);
}

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children: TreeNode[];
};

type OutlineItem = {
  title: string;
  level: number;
  pos: number;
  line: number;
};

function buildTree(items: { path: string; type: string }[], orderMap: Record<string, string[]> = {}) {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const nodeMap = new Map<string, TreeNode>([['', root]]);

  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));

  sorted.forEach((item) => {
    const parts = item.path.split('/').filter(Boolean);
    let currentPath = '';
    parts.forEach((part, index) => {
      const nextPath = currentPath ? `${currentPath}/${part}` : part;
      if (!nodeMap.has(nextPath)) {
        const isLeaf = index === parts.length - 1;
        const node: TreeNode = {
          name: part,
          path: nextPath,
          type: isLeaf ? (item.type === 'dir' ? 'dir' : 'file') : 'dir',
          children: []
        };
        const parent = nodeMap.get(currentPath);
        if (parent) {
          parent.children.push(node);
        }
        nodeMap.set(nextPath, node);
      }
      currentPath = nextPath;
    });
  });

  const sortNodes = (node: TreeNode) => {
    const order = orderMap[node.path] || [];
    node.children.sort((a, b) => {
      const aKey = a.name;
      const bKey = b.name;
      const aIndex = order.indexOf(aKey);
      const bIndex = order.indexOf(bKey);
      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        if (aIndex !== bIndex) return aIndex - bIndex;
      }
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNodes);
  };

  sortNodes(root);
  return root;
}

function findTreeNode(root: TreeNode, targetPath: string) {
  if (root.path === targetPath) return root;
  const parts = targetPath.split('/').filter(Boolean);
  let current: TreeNode | null = root;
  let pathSoFar = '';
  for (const part of parts) {
    if (!current) return null;
    pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
    current = current.children.find((child) => child.path === pathSoFar) || null;
  }
  return current;
}

function stripLineComment(line: string) {
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '%' && !escaped) {
      return line.slice(0, i);
    }
    escaped = ch === '\\';
  }
  return line;
}

function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  lines.forEach((line, index) => {
    const clean = stripLineComment(line);
    const regex = /\\+(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const name = match[1];
      const title = (match[2] || '').trim() || '(untitled)';
      const level = name === 'section' ? 1 : name === 'subsection' ? 2 : 3;
      items.push({
        title,
        level,
        pos: offset + (match.index ?? 0),
        line: index + 1
      });
    }
    offset += line.length + 1;
  });
  return items;
}

function extractIncludeTargets(text: string) {
  const targets: string[] = [];
  const lines = text.split(/\r?\n/);
  const regex = /\\(?:input|include)\s*\{([^}]+)\}/g;
  lines.forEach((line) => {
    const clean = stripLineComment(line);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const raw = (match[1] || '').trim();
      if (raw) targets.push(raw);
    }
  });
  return targets;
}

function findNearestHeading(text: string, cursorPos: number) {
  const before = text.slice(0, cursorPos);
  const lines = before.split(/\r?\n/).reverse();
  for (const line of lines) {
    const clean = stripLineComment(line);
    const match = clean.match(/\\+(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/);
    if (match) {
      return {
        title: (match[2] || '').trim() || '(untitled)',
        level: match[1]
      };
    }
  }
  return null;
}

function findCurrentEnvironment(text: string) {
  const stack: string[] = [];
  const clean = text
    .split('\n')
    .map((line) => stripLineComment(line))
    .join('\n');
  const regex = /\\\\(begin|end)\\s*\\{([^}]+)\\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(clean))) {
    const type = match[1];
    const name = match[2].trim();
    if (!name) continue;
    if (type === 'begin') {
      stack.push(name);
    } else if (type === 'end') {
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : '';
}

function extractJsonBlock(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function sanitizeJsonString(raw: string) {
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 0 && code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    try {
      return JSON.parse(sanitizeJsonString(raw)) as T;
    } catch (err2) {
      return null;
    }
  }
}

function appendLog(setter: (val: string[] | ((prev: string[]) => string[])) => void, line: string) {
  setter((prev) => [...prev, line]);
}

function findLineOffset(text: string, line: number) {
  if (line <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < line && offset < text.length) {
    const next = text.indexOf('\n', offset);
    if (next === -1) break;
    offset = next + 1;
    current += 1;
  }
  return offset;
}

function replaceSelection(source: string, start: number, end: number, replacement: string) {
  return source.slice(0, start) + replacement + source.slice(end);
}

export default function EditorPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return <ProjectEditorSession key={projectId} />;
}

// Project changes release editor history, tool results and in-flight UI state together.
function ProjectEditorSession() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { projectId: routeProjectId, stage: researchStage } = useParams<{ projectId: string; stage?: string }>();
  const [searchParams] = useSearchParams();
  const projectId = routeProjectId || '';
  const researchMode = Boolean(researchStage);
  const activeResearchStage: ResearchStageId = isResearchStageId(researchStage) ? researchStage : 'direction';
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [tree, setTree] = useState<{ path: string; type: string }[]>([]);
  const [fileOrder, setFileOrder] = useState<Record<string, string[]>>({});
  const [activePath, setActivePath] = useState<string>('');
  const [files, setFiles] = useState<Record<string, string>>({});
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [inlineSuggestionText, setInlineSuggestionText] = useState('');
  const [suggestionPos, setSuggestionPos] = useState<{ left: number; top: number } | null>(null);
  const assistant = useAssistantRun(projectId);
  const changeReview = useChangeReview(projectId, assistant.runs, assistant.remember);
  const drafts = useDocumentDrafts(projectId);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const openFileSequenceRef = useRef(0);
  const [rightViewDropdownOpen, setRightViewDropdownOpen] = useState(false);
  const [mainFileDropdownOpen, setMainFileDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [topBarDropdownRect, setTopBarDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [wsBibDropdownOpen, setWsBibDropdownOpen] = useState(false);
  const [wsTexDropdownOpen, setWsTexDropdownOpen] = useState(false);
  const [figureDropdownOpen, setFigureDropdownOpen] = useState(false);
  const pendingChanges = changeReview.pending;
  const { compile: compileDocument, abandonWait, waitingAbandoned, compileLog, compiledSources, compiledMainFile, inputSnapshot, diagnosticsVerified, pdfUrl, engineName, isCompiling, compileErrors } = useCompilation(projectId);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfFitWidth, setPdfFitWidth] = useState(true);
  const [pdfFitScale, setPdfFitScale] = useState<number | null>(null);
  const [pdfSpread, setPdfSpread] = useState(false);
  const [pdfOutline, setPdfOutline] = useState<{ title: string; page?: number; level: number }[]>([]);
  const [pdfAnnotations, setPdfAnnotations] = useState<{ id: string; page: number; x: number; y: number; text: string }[]>([]);
  const [pdfAnnotateMode, setPdfAnnotateMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [savePulse, setSavePulse] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [rightView, setRightView] = useState<'pdf' | 'figures' | 'diff' | 'log' | 'toc' | 'review'>('pdf');
  const [selectedFigure, setSelectedFigure] = useState<string>('');
  const [diffFocus, setDiffFocus] = useState<PendingChange | null>(null);
  const [activeSidebar, setActiveSidebar] = useState<'files' | 'agent' | 'vision' | 'search' | 'websearch' | 'plot' | 'review' | 'collab' | 'research'>('files');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [researchContextOpen, setResearchContextOpen] = useState(false);
  const [researchWorkspaceState, setResearchWorkspaceState] = useState<ResearchWorkspaceState | null>(null);
  const [columnSizes, setColumnSizes] = useState({ sidebar: 260, editor: 640, right: 420 });
  const [editorSplit, setEditorSplit] = useState(0.7);
  const [selectedPath, setSelectedPath] = useState('');
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [dragOverPath, setDragOverPath] = useState('');
  const [dragOverKind, setDragOverKind] = useState<'file' | 'folder' | ''>('');
  const [draggingPath, setDraggingPath] = useState('');
  const [dragHint, setDragHint] = useState<{ text: string; x: number; y: number } | null>(null);
  const [mainFile, setMainFile] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [editorFontSize, setEditorFontSize] = useState(11);
  const [visionMode, setVisionMode] = useState<'equation' | 'table' | 'figure' | 'algorithm' | 'ocr'>('equation');
  const [visionFile, setVisionFile] = useState<File | null>(null);
  const [visionPrompt, setVisionPrompt] = useState('');
  const [visionResult, setVisionResult] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionPreviewUrl, setVisionPreviewUrl] = useState('');
  const [arxivQuery, setArxivQuery] = useState('');
  const [arxivMaxResults, setArxivMaxResults] = useState(5);
  const [arxivResults, setArxivResults] = useState<ArxivPaper[]>([]);
  const [arxivSelected, setArxivSelected] = useState<Record<string, boolean>>({});
  const [arxivBusy, setArxivBusy] = useState(false);
  const [arxivStatus, setArxivStatus] = useState('');
  const [useLlmSearch, setUseLlmSearch] = useState(false);
  const [llmSearchOutput, setLlmSearchOutput] = useState('');
  const [arxivBibtexCache, setArxivBibtexCache] = useState<Record<string, string>>({});
  const [bibTarget, setBibTarget] = useState('');
  const [autoInsertCite, setAutoInsertCite] = useState(true);
  const [autoInsertToMain, setAutoInsertToMain] = useState(false);
  const [citeTargetFile, setCiteTargetFile] = useState('');
  const [outlineText, setOutlineText] = useState('');
  const [currentHeading, setCurrentHeading] = useState<{ title: string; level: string } | null>(null);
  const [plotType, setPlotType] = useState<'bar' | 'line' | 'heatmap'>('bar');
  const [plotTitle, setPlotTitle] = useState('');
  const [plotFilename, setPlotFilename] = useState('');
  const [plotPrompt, setPlotPrompt] = useState('');
  const [plotRetries, setPlotRetries] = useState(2);
  const [plotBusy, setPlotBusy] = useState(false);
  const [plotStatus, setPlotStatus] = useState('');
  const [plotAssetPath, setPlotAssetPath] = useState('');
  const [plotAutoInsert, setPlotAutoInsert] = useState(true);
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageSize, setImageSize] = useState<'1024x1024' | '1536x1024' | '1024x1536'>('1536x1024');
  const [imageQuality, setImageQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [imageBusy, setImageBusy] = useState(false);
  const [imageStatus, setImageStatus] = useState('');
  const [imageAssetPath, setImageAssetPath] = useState('');
  const [websearchQuery, setWebsearchQuery] = useState('');
  const [websearchLog, setWebsearchLog] = useState<string[]>([]);
  const [websearchBusy, setWebsearchBusy] = useState(false);
  const [websearchResults, setWebsearchResults] = useState<WebsearchItem[]>([]);
  const [websearchSelected, setWebsearchSelected] = useState<Record<string, boolean>>({});
  const [websearchParagraph, setWebsearchParagraph] = useState('');
  const [websearchItemNotes, setWebsearchItemNotes] = useState<Record<string, string>>({});
  const [websearchTargetFile, setWebsearchTargetFile] = useState('');
  const [websearchTargetBib, setWebsearchTargetBib] = useState('');
  const [reviewNotes, setReviewNotes] = useState<{ title: string; content: string }[]>([]);
  const [reviewReport, setReviewReport] = useState('');
  const [reviewReportBusy, setReviewReportBusy] = useState(false);
  const diagnoseBusy = assistant.busy;
  const [websearchSelectedAll, setWebsearchSelectedAll] = useState(false);
  const [collabEnabled, setCollabEnabled] = useState(() => Boolean(getCollabToken()));
  const [collabInviteBusy, setCollabInviteBusy] = useState(false);
  const [collabInviteLink, setCollabInviteLink] = useState('');
  const [collabServer, setCollabServerState] = useState(() => getCollabServer() || (typeof window === 'undefined' ? '' : window.location.origin));
  const [collabName, setCollabName] = useState(() => loadCollabName() || 'Guest');
  const [collabToken] = useState(() => getCollabToken());
  const editorAreaRef = useRef<HTMLDivElement | null>(null);
  const activePathRef = useRef<string>('');
  const inlineSuggestionRef = useRef<string>('');
  const inlineAnchorRef = useRef<number | null>(null);
  const applyingSuggestionRef = useRef(false);
  const requestSuggestionRef = useRef<() => void>(() => {});
  const acceptSuggestionRef = useRef<() => void>(() => {});
  const acceptChunkRef = useRef<() => void>(() => {});
  const clearSuggestionRef = useRef<() => void>(() => {});
  const saveActiveFileRef = useRef<() => void>(() => {});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const editorSplitRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const collabCompartment = useMemo(() => new Compartment(), []);
  const handleResearchStateChange = useCallback((next: ResearchWorkspaceState) => {
    setResearchWorkspaceState(next);
  }, []);

  const {
    llmEndpoint,
    llmApiKey,
    llmModel,
    agentRuntime,
    searchEndpoint,
    searchApiKey,
    searchModel,
    visionEndpoint,
    visionApiKey,
    visionModel,
    compileEngine
  } = settings;

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (researchMode) {
      setActiveSidebar('research');
      return;
    }
    setActiveSidebar((current) => current === 'research' ? 'files' : current);
  }, [researchMode, researchStage]);

  useEffect(() => {
    if (collabServer) {
      setCollabServer(collabServer);
    }
  }, [collabServer]);

  useEffect(() => { persistCollabName(collabName); }, [collabName]);

  const llmConfig = useMemo(
    () => ({
      endpoint: llmEndpoint,
      apiKey: llmApiKey || undefined,
      model: llmModel,
      runtime: agentRuntime
    }),
    [agentRuntime, llmEndpoint, llmApiKey, llmModel]
  );

  const searchLlmConfig = useMemo(() => {
    const hasOverride = Boolean(searchEndpoint || searchApiKey || searchModel);
    return {
      endpoint: (hasOverride ? searchEndpoint : llmEndpoint) || llmEndpoint,
      apiKey: (hasOverride ? searchApiKey : llmApiKey) || undefined,
      model: (hasOverride ? searchModel : llmModel) || llmModel
    };
  }, [llmEndpoint, llmApiKey, llmModel, searchEndpoint, searchApiKey, searchModel]);

  const visionLlmConfig = useMemo(() => {
    const hasOverride = Boolean(visionEndpoint || visionApiKey || visionModel);
    return {
      endpoint: (hasOverride ? visionEndpoint : llmEndpoint) || llmEndpoint,
      apiKey: (hasOverride ? visionApiKey : llmApiKey) || undefined,
      model: (hasOverride ? visionModel : llmModel) || llmModel
    };
  }, [llmEndpoint, llmApiKey, llmModel, visionEndpoint, visionApiKey, visionModel]);

  useEffect(() => {
    if (!projectId) {
      navigate('/projects', { replace: true });
      return;
    }
    setProjectName('');
    listProjects()
      .then((res) => {
        const current = res.projects.find((item) => item.id === projectId);
        if (!current) {
          setStatus(t('项目不存在或已被删除。'));
          return;
        }
        setProjectName(current.name);
      })
      .catch((err) => setStatus(t('加载项目信息失败: {{error}}', { error: String(err) })));
  }, [navigate, projectId, t]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  const handleCreateInvite = useCallback(async () => {
    if (!projectId) return;
    setCollabInviteBusy(true);
    try {
      const res = await createCollabInvite(projectId);
      if (!res.ok || !res.token) {
        throw new Error(t('邀请生成失败'));
      }
      const baseInput = normalizeServerUrl(collabServer) || (typeof window === 'undefined' ? '' : window.location.origin);
      const base = baseInput.replace(/\/$/, '');
      const link = `${base}/collab?token=${encodeURIComponent(res.token)}`;
      setCollabInviteLink(link);
      if (!collabEnabled) {
        setCollabEnabled(true);
      }
      setStatus(t('邀请链接已生成'));
    } catch (err) {
      setStatus(t('生成邀请失败: {{error}}', { error: String(err) }));
    } finally {
      setCollabInviteBusy(false);
    }
  }, [collabServer, projectId, t]);

  const copyInviteLink = useCallback(async () => {
    if (!collabInviteLink) return;
    try {
      await navigator.clipboard.writeText(collabInviteLink);
      setStatus(t('邀请链接已复制'));
    } catch (err) {
      setStatus(t('复制失败: {{error}}', { error: String(err) }));
    }
  }, [collabInviteLink, t]);

  const refreshTree = async (keepActive = true) => {
    if (!projectId) return;
    const res = await getProjectTree(projectId);
    const visibleItems = res.items.filter((item) => !isInternalProjectPath(item.path));
    setTree(visibleItems);
    setFileOrder(res.fileOrder || {});
    if (!keepActive || !activePath || !visibleItems.find((item) => item.path === activePath)) {
      const requested = searchParams.get('open');
      const filePaths = visibleItems.filter((item) => item.type === 'file').map((item) => item.path);
      const requestedPath = requested && filePaths.includes(requested) ? requested : '';
      const restoredPath = restoredEditorFile(projectId, filePaths);
      const main = visibleItems.find((item) => item.path.endsWith('main.tex'))?.path;
      const firstTex = visibleItems.find((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.tex'))?.path;
      const next = requestedPath || restoredPath || main || firstTex || filePaths[0] || '';
      if (next) {
        await openFile(next);
      }
    }
  };

  useEffect(() => {
    if (!projectId) return;
    setFiles({});
    setActivePath('');
    refreshTree(false).catch((err) => setStatus(t('加载文件树失败: {{error}}', { error: String(err) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, t]);


  const { hostRef: editorHostRef, viewRef: cmViewRef, value: editorValue,
    setValue: setEditorValue, selection: selectionRange, replaceDocument: setEditorDoc,
    } = useEditorSession({
    extensions: () => [...editorExtensions(collabCompartment.of([])), keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          saveActiveFileRef.current();
          return true;
        }
      },
      {
        key: 'Alt-/',
        run: () => {
          requestSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'Mod-/',
        run: toggleComment
      },
      {
        key: 'Mod-Space',
        run: () => {
          requestSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'ArrowRight',
        run: (view) => {
          const pos = view.state.selection.main.head;
          if (inlineSuggestionRef.current && inlineAnchorRef.current === pos) {
            acceptChunkRef.current();
            return true;
          }
          return false;
        }
      },
      {
        key: 'Tab',
        run: () => {
          if (!inlineSuggestionRef.current) return false;
          acceptSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'Escape',
        run: () => {
          clearSuggestionRef.current();
          return true;
        }
      },
      ...foldKeymap,
      ...searchKeymap
    ])],
    onChange: (value, programmatic) => {
      if (!programmatic && !collabActiveRef.current) setIsDirty(true);
      const path = activePathRef.current;
      if (path && (!programmatic || collabActiveRef.current)) {
        draftsRef.current.changed(path, value);
        setFiles((prev) => ({ ...prev, [path]: value }));
      }
    },
    onSelection: (value, head) => setCurrentHeading(findNearestHeading(value, head)),
    onCompletion: () => requestSuggestionRef.current(),
    onUpdate: (update) => {
      const skipClear = applyingSuggestionRef.current;
      if (!skipClear && inlineSuggestionRef.current && (update.docChanged || update.selectionSet)) {
        inlineSuggestionRef.current = '';
        inlineAnchorRef.current = null;
        setInlineSuggestionText('');
        setTimeout(() => {
          const view = cmViewRef.current;
          if (view) {
            view.dispatch({ effects: setGhostEffect.of({ pos: null, text: '' }) });
          }
        }, 0);
      }
      if (skipClear) {
        applyingSuggestionRef.current = false;
      }

    }
  });

  const { activeRef: collabActiveRef, status: collabStatus, peers: collabPeers,
    flush: flushCollaboration, replace: replaceCollaborativeDocument } = useCollaborationSession({
    projectId, path: activePath, enabled: collabEnabled, supported: isTextPath(activePath),
    server: collabServer, token: collabToken, name: collabName,
    viewRef: cmViewRef, compartment: collabCompartment,
    prepare: () => { setEditorDoc(''); setEditorValue(''); setIsDirty(false); },
    onStatus: setStatus
  });

  const openFile = async (filePath: string) => {
    const request = ++openFileSequenceRef.current;
    let draft = drafts.get(filePath);
    if (!draft) {
      const data = await getFile(projectId, filePath);
      if (request !== openFileSequenceRef.current || draftsRef.current !== drafts) return '';
      drafts.loaded(filePath, data.content, data.version);
      draft = drafts.get(filePath)!;
    }
    rememberEditorFile(projectId, filePath);
    setActivePath(filePath);
    activePathRef.current = filePath;
    setSelectedPath(filePath);
    if (filePath.includes('/')) {
      const parts = filePath.split('/').slice(0, -1);
      setOpenFolders((prev) => {
        const next = { ...prev };
        let current = '';
        parts.forEach((part) => {
          current = current ? `${current}/${part}` : part;
          next[current] = true;
        });
        return next;
      });
    }
    const content = draft.content;
    setFiles((prev) => ({ ...prev, [filePath]: content }));
    const collabTextFile = collabEnabled && isTextPath(filePath);
    setEditorValue(collabTextFile ? '' : content);
    setIsDirty(draft.content !== draft.saved);
    if (!collabTextFile) setEditorDoc(content);
    return content;
  };

  const clearInlineSuggestion = useCallback(() => {
    inlineSuggestionRef.current = '';
    inlineAnchorRef.current = null;
    setInlineSuggestionText('');
    setSuggestionPos(null);
    const view = cmViewRef.current;
    if (view) {
      view.dispatch({ effects: setGhostEffect.of({ pos: null, text: '' }) });
    }
  }, []);

  const nextSuggestionChunk = (text: string) => {
    const match = text.match(/^(\s*\S+\s*)/);
    return match ? match[1] : text;
  };

  const acceptInlineSuggestion = useCallback(() => {
    const view = cmViewRef.current;
    const text = inlineSuggestionRef.current;
    const pos = inlineAnchorRef.current;
    if (!view || !text || pos == null) return;
    applyingSuggestionRef.current = true;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length }
    });
    clearInlineSuggestion();
  }, [clearInlineSuggestion]);

  const acceptSuggestionChunk = useCallback(() => {
    const view = cmViewRef.current;
    const remaining = inlineSuggestionRef.current;
    const pos = inlineAnchorRef.current;
    if (!view || !remaining || pos == null) return;
    const chunk = nextSuggestionChunk(remaining);
    applyingSuggestionRef.current = true;
    view.dispatch({
      changes: { from: pos, to: pos, insert: chunk },
      selection: { anchor: pos + chunk.length }
    });
    const leftover = remaining.slice(chunk.length);
    if (!leftover) {
      clearInlineSuggestion();
      return;
    }
    inlineSuggestionRef.current = leftover;
    inlineAnchorRef.current = pos + chunk.length;
    setInlineSuggestionText(leftover);
    view.dispatch({ effects: setGhostEffect.of({ pos: pos + chunk.length, text: leftover }) });
  }, [clearInlineSuggestion]);

  const updateSuggestionPosition = useCallback((force = false) => {
    const view = cmViewRef.current;
    const anchor = inlineAnchorRef.current;
    const host = editorAreaRef.current;
    if (!view || !host || (!inlineSuggestionRef.current && !force) || anchor == null) {
      setSuggestionPos(null);
      return;
    }
    const coords = view.coordsAtPos(anchor);
    if (!coords) {
      setSuggestionPos(null);
      return;
    }
    const rect = host.getBoundingClientRect();
    const preferredLeft = coords.left - rect.left;
    const preferredTop = coords.bottom - rect.top + 6;
    const popoverWidth = 320;
    const clampedLeft = Math.min(Math.max(12, preferredLeft), Math.max(12, rect.width - popoverWidth));
    let top = preferredTop;
    if (preferredTop + 80 > rect.height) {
      top = Math.max(12, coords.top - rect.top - 62);
    }
    setSuggestionPos({ left: clampedLeft, top });
  }, []);

  const requestInlineSuggestion = useCallback(async () => {
    const view = cmViewRef.current;
    if (!view || isSuggesting) return;
    clearInlineSuggestion();
    const pos = view.state.selection.main.head;
    const docText = view.state.doc.toString();
    const before = docText.slice(Math.max(0, pos - 4000), pos);
    const after = docText.slice(pos, pos + 400);
    const heading = findNearestHeading(docText, pos);
    const env = findCurrentEnvironment(docText.slice(0, pos));
    inlineAnchorRef.current = pos;
    setIsSuggesting(true);
    updateSuggestionPosition(true);
    try {
      const res = await runAgent({
        task: 'autocomplete',
        prompt: [
          t('You are a LaTeX writing assistant.'),
          t('Continue after <CURSOR> with a coherent next block (1-2 paragraphs or a full environment).'),
          heading ? t('Current section: {{title}} ({{level}}).', { title: heading.title, level: heading.level }) : '',
          env ? t('You are inside environment: {{env}}.', { env }) : '',
          t('Preserve style and formatting.'),
          t('Return only the continuation text, no commentary.')
        ].filter(Boolean).join(' '),
        selection: '',
        content: `${before}<CURSOR>${after}`,
        mode: 'direct',
        projectId,
        activePath,
        compileLog,
        llmConfig
      });
      const suggestion = (res.suggestion || res.reply || '').trim();
      if (!suggestion) return;
      inlineSuggestionRef.current = suggestion;
      inlineAnchorRef.current = pos;
      setInlineSuggestionText(suggestion);
      view.dispatch({
        effects: setGhostEffect.of({ pos, text: suggestion })
      });
    } catch (err) {
      setStatus(t('补全失败: {{error}}', { error: String(err) }));
    } finally {
      setIsSuggesting(false);
      if (!inlineSuggestionRef.current) {
        setSuggestionPos(null);
      }
    }
  }, [activePath, clearInlineSuggestion, compileLog, isSuggesting, llmConfig, projectId, updateSuggestionPosition, t]);

  useEffect(() => {
    if (!inlineSuggestionText) {
      setSuggestionPos(null);
      return;
    }
    updateSuggestionPosition();
  }, [inlineSuggestionText, updateSuggestionPosition]);

  useEffect(() => {
    const view = cmViewRef.current;
    if (!view) return;
    const handleScroll = () => {
      if (inlineSuggestionRef.current) {
        updateSuggestionPosition();
      }
    };
    view.scrollDOM.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleScroll);
    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [updateSuggestionPosition]);

  useEffect(() => {
    if (!inlineSuggestionRef.current) return;
    updateSuggestionPosition();
  }, [columnSizes, editorSplit, updateSuggestionPosition]);

  useEffect(() => {
    requestSuggestionRef.current = requestInlineSuggestion;
    acceptSuggestionRef.current = acceptInlineSuggestion;
    acceptChunkRef.current = acceptSuggestionChunk;
    clearSuggestionRef.current = clearInlineSuggestion;
  }, [requestInlineSuggestion, acceptInlineSuggestion, acceptSuggestionChunk, clearInlineSuggestion]);

  const saveActiveFile = useCallback(
    async (opts?: { silent?: boolean; throwOnError?: boolean }) => {
      setIsSaving(true);
      try {
        const stored = await flushCollaboration();
        if (stored) drafts.loaded(activePath, stored.content, stored.version);
        await drafts.save();
        const draft = drafts.get(activePath);
        if (activePathRef.current === activePath) setIsDirty(Boolean(draft && draft.content !== draft.saved));
        setSavePulse(true);
        window.setTimeout(() => setSavePulse(false), 1200);
        if (!opts?.silent) setStatus(t('已保存 {{path}}', { path: activePath }));
      } catch (err) {
        setStatus(t('保存失败: {{error}}', { error: String(err) }));
        if (opts?.throwOnError) throw err;
      } finally { setIsSaving(false); }
    },
    [activePath, flushCollaboration, drafts, t]
  );

  const writeFileCompat = useCallback(
    async (path: string, content: string) => {
      if (replaceCollaborativeDocument(path, content)) {
        setIsDirty(false);
        return { ok: true };
      }
      return drafts.exclusive(async () => {
        const draft = drafts.get(path);
        const result = await writeFile(projectId, path, content, draft?.version);
        if (!result.ok) throw new Error(t('保存失败: {{error}}', { error: path }));
        drafts.persisted(path, content, result.version, draft?.content);
        return result;
      });
    },
    [replaceCollaborativeDocument, drafts, projectId, t]
  );

  useEffect(() => {
    saveActiveFileRef.current = () => saveActiveFile();
  }, [saveActiveFile]);

  useEffect(() => {
    if (!cmViewRef.current) return;
    if (collabActiveRef.current || collabEnabled) return;
    setEditorDoc(editorValue);
  }, [editorValue, setEditorDoc, collabEnabled]);

  useEffect(() => {
    if (collabActiveRef.current) return;
    if (!isDirty || !activePath) return;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveActiveFile({ silent: true });
    }, 1500);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [activePath, editorValue, isDirty, saveActiveFile, collabEnabled]);

  const createBibFile = async () => {
    if (!projectId) return;
    const parent = selectedPath && tree.find((item) => item.path === selectedPath && item.type === 'dir')
      ? selectedPath
      : getParentPath(selectedPath || activePath || '');
    const path = parent ? `${parent}/references.bib` : 'references.bib';
    const content = '% Add BibTeX entries here\n';
    await writeFileCompat(path, content);
    await refreshTree();
    await openFile(path);
    return path;
  };

  const insertAtCursor = (text: string, opts?: { block?: boolean }) => {
    if (!activePath) return;
    const view = cmViewRef.current;
    if (!view) return;
    const selection = view.state.selection.main;
    const sel = activePath.toLowerCase().endsWith('.tex')
      ? getLatexBodyInsertionRange(view.state.doc.toString(), selection.from, selection.to)
      : selection;
    let insert = text;
    if (opts?.block) {
      const before = sel.from > 0 ? view.state.doc.sliceString(sel.from - 1, sel.from) : '';
      if (before && before !== '\n') {
        insert = `\n${insert}`;
      }
      if (!insert.endsWith('\n\n')) {
        insert = insert.endsWith('\n') ? `${insert}\n` : `${insert}\n\n`;
      }
    }
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length }
    });
  };

  const insertFigureSnippet = (filePath: string) => {
    const snippet = [
      '\\begin{figure}[t]',
      '\\centering',
      `\\includegraphics[width=0.9\\linewidth]{${filePath}}`,
      '\\caption{Caption.}',
      `\\label{fig:${filePath.replace(/[^a-zA-Z0-9]+/g, '-')}}`,
      '\\end{figure}',
      ''
    ].join('\n');
    insertAtCursor(snippet, { block: true });
  };

  const insertSectionSnippet = () => insertAtCursor('\\section{Section Title}', { block: true });

  const insertSubsectionSnippet = () => insertAtCursor('\\subsection{Subsection Title}', { block: true });

  const insertSubsubsectionSnippet = () => insertAtCursor('\\subsubsection{Subsubsection Title}', { block: true });

  const insertItemizeSnippet = () => insertAtCursor(['\\begin{itemize}', '\\item ', '\\end{itemize}'].join('\n'), { block: true });

  const insertEnumerateSnippet = () => insertAtCursor(['\\begin{enumerate}', '\\item ', '\\end{enumerate}'].join('\n'), { block: true });

  const insertEquationSnippet = () => insertAtCursor(['\\begin{equation}', 'E = mc^2', '\\end{equation}'].join('\n'), { block: true });

  const insertTableSnippet = () =>
    insertAtCursor(['\\begin{table}[t]', '\\centering', '\\begin{tabular}{lcc}', '\\toprule', 'Method & A & B \\\\', '\\midrule', 'Ours & 0.0 & 0.0 \\\\', '\\bottomrule', '\\end{tabular}', '\\caption{Table caption.}', '\\label{tab:main}', '\\end{table}'].join('\n'), { block: true });

  const insertListingSnippet = () =>
    insertAtCursor(['\\begin{lstlisting}[language=Python]', '# code here', '\\end{lstlisting}'].join('\n'), { block: true });

  const insertAlgorithmSnippet = () =>
    insertAtCursor(['\\begin{algorithm}[t]', '\\caption{Algorithm}', '\\label{alg:main}', '\\begin{algorithmic}', '\\State Initialize', '\\end{algorithmic}', '\\end{algorithm}'].join('\n'), { block: true });

  const insertCiteSnippet = () => insertAtCursor('\\cite{citation-key}');

  const insertRefSnippet = () => insertAtCursor('\\ref{label}');

  const insertLabelSnippet = () => insertAtCursor('\\label{label}');

  const insertFigureTemplate = () =>
    insertAtCursor(['\\begin{figure}[t]', '\\centering', '\\includegraphics[width=0.9\\linewidth]{figures/placeholder.png}', '\\caption{Caption.}', '\\label{fig:placeholder}', '\\end{figure}'].join('\n'), { block: true });

  const ensureFileContent = useCallback(
    async (path: string) => {
      const draft = drafts.get(path);
      if (draft) return draft.content;
      const data = await getFile(projectId, path);
      if (draftsRef.current === drafts) {
        // Another reader may have opened and edited this file during the fetch.
        if (!drafts.get(path)) drafts.loaded(path, data.content, data.version);
        setFiles((prev) => ({ ...prev, [path]: drafts.get(path)!.content }));
      }
      return drafts.get(path)?.content ?? data.content;
    },
    [drafts, projectId]
  );

  const buildProjectContext = useCallback(async () => {
    const root = mainFile || activePath;
    if (!root) return '';
    const visited = new Set<string>();
    const queue: string[] = [root];
    const summaries: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (!current.toLowerCase().endsWith('.tex')) continue;
      let content = '';
      try {
        content = await ensureFileContent(current);
      } catch {
        continue;
      }
      const outline = parseOutline(content).slice(0, 12);
      const headings = outline.map((item) => `${'  '.repeat(item.level - 1)}- ${item.title}`);
      summaries.push(t('File: {{file}}\n{{headings}}', { file: current, headings: headings.join('\n') }));
      const baseDir = getParentPath(current);
      const includes = extractIncludeTargets(content);
      includes.forEach((raw) => {
        let target = raw.replace(/^\//, '');
        if (!target.endsWith('.tex')) {
          target = `${target}.tex`;
        }
        const resolved = baseDir ? `${baseDir}/${target}` : target;
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      });
    }
    const filesList = Array.from(visited).join(', ');
    return t('Project files: {{files}}\nOutline:\n{{summaries}}', { files: filesList, summaries: summaries.join('\n') });
  }, [activePath, ensureFileContent, mainFile, t]);

  const extractBibKey = (bibtex: string) => {
    const match = bibtex.match(/@\w+\s*{\s*([^,\s]+)\s*,/);
    return match ? match[1].trim() : '';
  };

  const handleArxivSearch = useCallback(async () => {
    const query = arxivQuery.trim();
    if (!query) {
      setArxivStatus(t('请输入检索关键词。'));
      return;
    }
    setArxivBusy(true);
    setArxivStatus('');
    try {
      if (useLlmSearch) {
        setLlmSearchOutput('');
        const res = await runAgent({
          task: 'websearch',
          prompt: [
            t('Search arXiv for the user query.'),
            t('Return at most {{max}} papers.', { max: arxivMaxResults }),
            t('Use arxiv_search and arxiv_bibtex tools.'),
            t('Return JSON ONLY in this schema:'),
            t('{"papers":[{"title":"","authors":[],"arxivId":"","bibtex":""}]}.')
          ].join(' '),
          selection: '',
          content: query,
          mode: 'tools',
          projectId,
          activePath,
          compileLog,
          llmConfig: searchLlmConfig,
          interaction: 'agent',
          history: []
        });
        const raw = res.reply || '';
        if (raw) {
          setLlmSearchOutput(raw);
        }
        const jsonBlock = extractJsonBlock(raw);
        if (!jsonBlock) {
          throw new Error(t('LLM 输出无法解析为 JSON。'));
        }
        const parsed = safeJsonParse<{ papers?: { title: string; authors?: string[]; arxivId: string; bibtex?: string }[] }>(jsonBlock);
        if (!parsed) {
          throw new Error(t('LLM 输出 JSON 解析失败。'));
        }
        const papers = parsed.papers || [];
        setArxivResults(
          papers.map((paper) => ({
            title: paper.title || t('(untitled)'),
            abstract: '',
            authors: paper.authors || [],
            url: paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '',
            arxivId: paper.arxivId
          }))
        );
        const cache: Record<string, string> = {};
        papers.forEach((paper) => {
          if (paper.arxivId && paper.bibtex) {
            cache[paper.arxivId] = paper.bibtex;
          }
        });
        setArxivBibtexCache(cache);
        setArxivSelected({});
        if (papers.length === 0) {
          setArxivStatus(t('没有匹配结果。'));
        }
      } else {
        const res = await arxivSearch({ query, maxResults: arxivMaxResults });
        if (!res.ok) {
          throw new Error(res.error || t('检索失败'));
        }
        setArxivResults(res.papers || []);
        setArxivSelected({});
        if ((res.papers || []).length === 0) {
          setArxivStatus(t('没有匹配结果。'));
        }
      }
    } catch (err) {
      setArxivStatus(t('检索失败: {{error}}', { error: String(err) }));
    } finally {
      setArxivBusy(false);
    }
  }, [arxivQuery, arxivMaxResults, useLlmSearch, projectId, activePath, compileLog, searchLlmConfig, t]);

  const handleArxivApply = useCallback(async () => {
    if (!projectId) return;
    const selected = arxivResults.filter((paper) => arxivSelected[paper.arxivId]);
    if (selected.length === 0) {
      setArxivStatus(t('请选择要导入的论文。'));
      return;
    }
    let targetBib = bibTarget;
    if (!targetBib) {
      const created = await createBibFile();
      if (created) {
        targetBib = created;
        setBibTarget(created);
      }
    }
    if (!targetBib) {
      setArxivStatus(t('请先创建 Bib 文件。'));
      return;
    }
    setArxivBusy(true);
    setArxivStatus(t('正在写入 Bib...'));
    try {
      let content = await ensureFileContent(targetBib);
      const keys: string[] = [];
      for (const paper of selected) {
        let bibtexSource = arxivBibtexCache[paper.arxivId] || '';
        if (!bibtexSource) {
          const res = await arxivBibtex({ arxivId: paper.arxivId });
          if (!res.ok || !res.bibtex) {
            throw new Error(res.error || t('生成 BibTeX 失败: {{id}}', { id: paper.arxivId }));
          }
          bibtexSource = res.bibtex;
        }
        const normalizedBibtex = bibtexSource.replace(/\\n/g, '\n');
        const key = extractBibKey(normalizedBibtex);
        if (key) {
          const exists = new RegExp(`@\\w+\\s*{\\s*${key}\\s*,`, 'i').test(content);
          if (exists) {
            keys.push(key);
            continue;
          }
          keys.push(key);
        }
        if (content && !content.endsWith('\n')) content += '\n';
        content += `${normalizedBibtex.trim()}\n`;
      }
      await writeFileCompat(targetBib, content);
      setFiles((prev) => ({ ...prev, [targetBib]: content }));
      if (activePath === targetBib) {
        setEditorValue(content);
        if (!collabActiveRef.current) {
          setEditorDoc(content);
        }
      }
      if (autoInsertCite && keys.length > 0) {
        if (activePath && activePath.toLowerCase().endsWith('.tex')) {
          insertAtCursor(`\\cite{${keys.join(',')}}`);
        } else {
          setArxivStatus(t('Bib 已写入。打开 TeX 文件后可插入引用。'));
          setArxivBusy(false);
          return;
        }
      }
      if (autoInsertToMain && keys.length > 0) {
        const targetFile = citeTargetFile || mainFile;
        if (!targetFile) {
          setArxivStatus(t('未选择引用插入文件。'));
          setArxivBusy(false);
          return;
        }
        const citePayload = arxivResults
          .filter((paper) => keys.includes(extractBibKey(arxivBibtexCache[paper.arxivId] || '') || ''))
          .map((paper) => ({
            title: paper.title,
            arxivId: paper.arxivId
          }));
        const prompt = [
          t('Insert citations into the target TeX file.'),
          t('Target file: {{file}}.', { file: targetFile }),
          t('Use \\\\cite{{{keys}}}.', { keys: keys.join(',') }),
          t('If a Related Work section exists, add the citations there.'),
          t('Otherwise add a Related Work subsection near the end and cite the papers.'),
          t('Keep edits minimal and preserve formatting.'),
          citePayload.length > 0 ? t('Papers: {{payload}}', { payload: JSON.stringify(citePayload) }) : ''
        ].filter(Boolean).join(' ');
        try {
          await ensureFileContent(targetFile);
          const started = await assistant.start({ task: 'insert_citations', prompt, permission: 'edit',
            activePath: targetFile, llmConfig: searchLlmConfig, history: assistant.history }, prepareAssistantDocuments);
          if (started) { setActiveSidebar('agent'); setSidebarOpen(true); }
          setArxivStatus(started ? t('引用任务已启动，请在助手中查看和审阅。') : t('引用任务未启动，请查看助手提示。'));
        } catch (err) {
          setArxivStatus(t('引用插入失败: {{error}}', { error: String(err) }));
        }
      } else {
        setArxivStatus(t('已写入 Bib。'));
      }
    } catch (err) {
      setArxivStatus(t('写入失败: {{error}}', { error: String(err) }));
    } finally {
      setArxivBusy(false);
    }
  }, [activePath, arxivResults, arxivSelected, autoInsertCite, autoInsertToMain, bibTarget, projectId, createBibFile, ensureFileContent, setEditorDoc, arxivBibtexCache, compileLog, searchLlmConfig, mainFile, files, citeTargetFile, t]);

  const handlePlotGenerate = async () => {
    if (!projectId) return;
    if (!selectionText || (!selectionText.includes('\\begin{tabular') && !selectionText.includes('\\begin{table'))) {
      setPlotStatus(t('请在编辑器中选择一个 LaTeX 表格 (tabular)。'));
      return;
    }
    setPlotBusy(true);
    setPlotStatus('');
    try {
      const res = await plotFromTable({
        projectId,
        tableLatex: selectionText,
        chartType: plotType,
        title: plotTitle.trim() || undefined,
        prompt: plotPrompt.trim() || undefined,
        filename: plotFilename.trim() || undefined,
        retries: plotRetries,
        llmConfig
      });
      if (!res.ok || !res.assetPath) {
        throw new Error(res.error || t('图表生成失败'));
      }
      setPlotAssetPath(res.assetPath);
      setPlotStatus(t('图表已生成'));
      await refreshTree();
      if (plotAutoInsert) {
        insertFigureSnippet(res.assetPath);
      }
    } catch (err) {
      setPlotStatus(t('生成失败: {{error}}', { error: String(err) }));
    } finally {
      setPlotBusy(false);
    }
  };

  const handleGptImageGenerate = async () => {
    if (!projectId || !imagePrompt.trim()) {
      setImageStatus(t('请输入图像描述。'));
      return;
    }
    setImageBusy(true);
    setImageStatus('');
    try {
      const result = await generateGptImage({ projectId, prompt: imagePrompt.trim(), size: imageSize, quality: imageQuality, llmConfig });
      if (!result.ok || !result.assetPath) throw new Error(result.error || t('图像生成失败'));
      setImageAssetPath(result.assetPath);
      setImageStatus(t('图像已生成'));
      await refreshTree();
    } catch (error) {
      setImageStatus(t('生成失败: {{error}}', { error: String(error) }));
    } finally {
      setImageBusy(false);
    }
  };

  const runWebsearch = async () => {
    const query = websearchQuery.trim();
    if (!query) {
      setWebsearchLog([t('请输入查询关键词。')]);
      return;
    }
    setWebsearchBusy(true);
    setWebsearchLog([]);
    setWebsearchResults([]);
    setWebsearchSelected({});
    setWebsearchSelectedAll(false);
    setWebsearchParagraph('');
    setWebsearchItemNotes({});
    try {
      appendLog(setWebsearchLog, t('拆分查询...'));
      const splitRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          { role: 'system', content: t('Split the query into 2-4 targeted search queries. Return JSON only: {"queries":["..."]}.') },
          { role: 'user', content: t('用户问题: {{query}}', { query }) }
        ]
      });
      if (!splitRes.ok || !splitRes.content) {
        throw new Error(splitRes.error || t('Query split failed'));
      }
      const jsonBlock = extractJsonBlock(splitRes.content);
      if (!jsonBlock) {
        throw new Error(t('无法解析拆分结果 JSON。'));
      }
      const parsed = safeJsonParse<{ queries?: string[] }>(jsonBlock);
      if (!parsed) {
        throw new Error(t('拆分结果 JSON 解析失败。'));
      }
      const queries = (parsed.queries || []).filter(Boolean).slice(0, 4);
      if (queries.length === 0) {
        throw new Error(t('拆分结果为空。'));
      }
      appendLog(setWebsearchLog, t('逐项检索: {{queries}}', { queries: queries.join(' | ') }));
      const aggregated: WebsearchItem[] = [];
      for (const [idx, q] of queries.entries()) {
          appendLog(setWebsearchLog, t('检索中: {{query}}', { query: q }));
          const res = await callLLM({
            llmConfig: searchLlmConfig,
            messages: [
              {
                role: 'system',
                content:
                  t('You are a search assistant. Use the provider search. Return JSON only: {"results":[{"title":"","summary":"","url":"","bibtex":""}]}.')
              },
              { role: 'user', content: t('帮我检索: {{query}}', { query: q }) }
            ]
          });
          if (!res.ok || !res.content) {
            appendLog(setWebsearchLog, t('检索失败: {{query}}', { query: q }));
            continue;
          }
          const block = extractJsonBlock(res.content);
          if (!block) {
            appendLog(setWebsearchLog, t('结果解析失败: {{query}}', { query: q }));
            continue;
          }
          const parsedRes = safeJsonParse<{ results?: { title?: string; summary?: string; url?: string; bibtex?: string }[] }>(block);
          if (!parsedRes) {
            appendLog(setWebsearchLog, t('结果 JSON 解析失败: {{query}}', { query: q }));
            continue;
          }
          const results = parsedRes.results || [];
          results.forEach((item, i) => {
            const bibtex = item.bibtex || '';
            const citeKey = bibtex ? extractBibKey(bibtex.replace(/\\n/g, '\n')) : '';
            aggregated.push({
              id: `${idx}-${i}-${item.url || item.title || 'result'}`,
              title: item.title || t('Untitled'),
              summary: item.summary || '',
              url: item.url || '',
              bibtex,
              citeKey
            });
          });
          appendLog(setWebsearchLog, t('完成: {{query}} ({{count}})', { query: q, count: results.length }));
      }
      const deduped: WebsearchItem[] = [];
      aggregated.forEach((item) => {
        if (!deduped.find((d) => d.url && item.url && d.url === item.url) && !deduped.find((d) => d.title === item.title)) {
          deduped.push(item);
        }
      });
      setWebsearchResults(deduped);
      appendLog(setWebsearchLog, t('聚合结果: {{count}} 条', { count: deduped.length }));
      if (deduped.length === 0) {
        setWebsearchBusy(false);
        return;
      }
      appendLog(setWebsearchLog, t('生成逐条总结...'));
      const summariesRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              t('你是论文检索助手。请为每篇论文写一条简短总结（1-2 句）。返回 JSON：{"summaries":[{"id":"","summary":""}]}.')
          },
          {
            role: 'user',
            content: JSON.stringify({
              papers: deduped.map((p) => ({
                id: p.id,
                title: p.title,
                summary: p.summary,
                url: p.url,
                citeKey: p.citeKey
              }))
            })
          }
        ]
      });
      if (summariesRes.ok && summariesRes.content) {
        const summaryBlock = extractJsonBlock(summariesRes.content);
        const parsedSummaries = summaryBlock
          ? safeJsonParse<{ summaries?: { id: string; summary: string }[] }>(summaryBlock)
          : null;
        if (parsedSummaries?.summaries?.length) {
          const notes: Record<string, string> = {};
          parsedSummaries.summaries.forEach((item) => {
            if (item.id && item.summary) {
              notes[item.id] = item.summary.trim();
            }
          });
          setWebsearchItemNotes(notes);
          appendLog(setWebsearchLog, t('逐条总结已生成。'));
        } else {
          appendLog(setWebsearchLog, t('逐条总结解析失败。'));
        }
      } else {
        appendLog(setWebsearchLog, t('逐条总结生成失败。'));
      }

      appendLog(setWebsearchLog, t('生成综合总结...'));
      const citeKeys = deduped.map((item) => item.citeKey).filter(Boolean);
      const paragraphRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              t('请根据提供论文生成 3-5 句中文综合总结（不要分条）。可以使用 \\cite{...} 引用。只返回总结文本。')
          },
          {
            role: 'user',
            content: JSON.stringify({ query, papers: deduped.map((p) => ({ title: p.title, summary: p.summary, url: p.url })), citeKeys })
          }
        ]
      });
      if (paragraphRes.ok && paragraphRes.content) {
        setWebsearchParagraph(paragraphRes.content.trim());
        appendLog(setWebsearchLog, t('段落已生成。'));
      } else {
        appendLog(setWebsearchLog, t('段落生成失败。'));
      }
    } catch (err) {
      appendLog(setWebsearchLog, t('错误: {{error}}', { error: String(err) }));
    } finally {
      setWebsearchBusy(false);
    }
  };

  const applyWebsearchInsert = async () => {
    if (!projectId) return;
    let targetBib = websearchTargetBib;
    if (!targetBib) {
      const created = await createBibFile();
      if (created) targetBib = created;
    }
    if (!targetBib) {
      setWebsearchLog((prev) => [...prev, t('缺少 Bib 文件。')]);
      return;
    }
    let content = await ensureFileContent(targetBib);
    const keys: string[] = [];
    const selectedItems = websearchResults.filter((item) => websearchSelected[item.id]);
    if (selectedItems.length === 0) {
      appendLog(setWebsearchLog, t('请选择至少一条结果。'));
      return;
    }
    const perItemLines = selectedItems.map((item) => {
      const note = websearchItemNotes[item.id] || item.summary || item.title;
      const cite = item.citeKey ? ` \\cite{${item.citeKey}}` : '';
      return `  \\item ${note}${cite}`;
    });
    selectedItems.forEach((item) => {
      if (!item.bibtex) return;
      const normalized = item.bibtex.replace(/\\n/g, '\n');
      const key = extractBibKey(normalized);
      if (!key) return;
      if (new RegExp(`@\\w+\\s*{\\s*${key}\\s*,`, 'i').test(content)) {
        keys.push(key);
        return;
      }
      keys.push(key);
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${normalized.trim()}\n`;
    });
    await writeFileCompat(targetBib, content);
    setFiles((prev) => ({ ...prev, [targetBib]: content }));
    appendLog(setWebsearchLog, t('Bib 写入完成: {{path}}', { path: targetBib }));

    const targetFile = websearchTargetFile || mainFile || activePath;
    const perItemBlock = perItemLines.length
      ? `\\paragraph{${t('逐条总结')}}\n\\begin{itemize}\n${perItemLines.join('\n')}\n\\end{itemize}\n\n`
      : '';
    const finalBlock = websearchParagraph ? `\\paragraph{${t('综合总结')}}\n${websearchParagraph}\n` : '';
    const insertBlock = `${perItemBlock}${finalBlock}`.trim();
    if (!insertBlock) {
      appendLog(setWebsearchLog, t('没有可插入的总结内容。'));
      return;
    }
    if (targetFile && targetFile.toLowerCase().endsWith('.tex')) {
      const targetContent = await ensureFileContent(targetFile);
      const insertText = insertBlock ? `\n${insertBlock}\n` : '\n';
      const nextContent = `${targetContent}\n${insertText}`.replace(/\n{3,}/g, '\n\n');
      await writeFileCompat(targetFile, nextContent);
      setFiles((prev) => ({ ...prev, [targetFile]: nextContent }));
      if (activePath === targetFile) {
        setEditorValue(nextContent);
        if (!collabActiveRef.current) {
          setEditorDoc(nextContent);
        }
      }
      appendLog(setWebsearchLog, t('段落已插入 {{path}}', { path: targetFile }));
    } else if (activePath && activePath.toLowerCase().endsWith('.tex')) {
      if (insertBlock) {
        insertAtCursor(insertBlock, { block: true });
      }
      appendLog(setWebsearchLog, t('段落已插入光标位置。'));
    }
  };

  const handleUpload = async (fileList: FileList | null, basePath = '') => {
    if (!projectId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    await uploadFiles(projectId, files, basePath);
    await refreshTree();
  };

  const handleVisionSubmit = async () => {
    if (!projectId) return;
    if (!visionFile) {
      setStatus(t('请先选择图片。'));
      return;
    }
    setVisionBusy(true);
    setVisionResult('');
    try {
      let extraPrompt = visionPrompt.trim();
      if (!extraPrompt) {
        if (visionMode === 'table') {
          extraPrompt = t('只输出表格的 LaTeX（tabular 或 table），不要包含文档结构。');
        } else if (visionMode === 'algorithm') {
          extraPrompt = t('只输出 algorithm/algorithmic 环境，不要包含文档结构。');
        } else if (visionMode === 'equation') {
          extraPrompt = t('只输出 equation 环境，不要包含文档结构。');
        }
      }
      const res = await visionToLatex({
        projectId,
        file: visionFile,
        mode: visionMode,
        prompt: extraPrompt,
        llmConfig: visionLlmConfig
      });
      if (!res.ok) {
        throw new Error(res.error || t('识别失败'));
      }
      setVisionResult(res.latex || '');
    } catch (err) {
      setStatus(t('识别失败: {{error}}', { error: String(err) }));
    } finally {
      setVisionBusy(false);
    }
  };

  const handleVisionInsert = () => {
    if (!visionResult) return;
    insertAtCursor(visionResult, { block: true });
  };

  const beginInlineCreate = (kind: 'new-file' | 'new-folder') => {
    if (!projectId) return;
    const selectedIsDir = selectedPath && tree.find((item) => item.path === selectedPath && item.type === 'dir');
    const parent = selectedIsDir ? selectedPath : getParentPath(selectedPath || activePath || '');
    setInlineEdit({ kind, parent, value: '' });
    if (parent) {
      setOpenFolders((prev) => ({ ...prev, [parent]: true }));
    }
  };

  const beginInlineRename = () => {
    if (!projectId) return;
    const target = selectedPath || activePath;
    if (!target) return;
    const name = target.split('/').pop() || target;
    setInlineEdit({ kind: 'rename', path: target, value: name });
  };

  const handleDeleteFile = async () => {
    if (!projectId) return;
    const target = selectedPath || activePath;
    if (!target) return;

    const confirmMessage = t('确定要删除 "{name}" 吗？此操作不可恢复。', { name: target.split('/').pop() || target });
    if (!window.confirm(confirmMessage)) return;

    try {
      const result = await deleteFile(projectId, target);
      if (result.ok) {
        drafts.forget(target);
        setFiles((previous) => Object.fromEntries(Object.entries(previous).filter(([path]) => path !== target && !path.startsWith(`${target}/`))));
        // If deleted file was the active file, clear it
        if (target === activePath) {
          setActivePath('');
          setEditorValue('');
        }
        // Refresh the file tree
        refreshTree();
      } else {
        alert(result.error || t('删除失败'));
      }
    } catch (err) {
      console.error('Delete error:', err);
      alert(t('删除失败') + ': ' + String(err));
    }
  };

  const confirmInlineEdit = async () => {
    if (!projectId || !inlineEdit) return;
    const value = inlineEdit.value.trim();
    if (!value) {
      setInlineEdit(null);
      return;
    }
    if (inlineEdit.kind === 'rename') {
      const from = inlineEdit.path;
      const parent = getParentPath(from);
      const to = parent ? `${parent}/${value}` : value;
      const entry = tree.find((item) => item.path === from);
      const fromName = from.split('/').pop() || '';
      await drafts.exclusive(async () => {
        await renamePath(projectId, from, to);
        drafts.rename(from, to);
      });
      if (activePath === from) {
        setActivePath(to);
        activePathRef.current = to;
      }
      setSelectedPath(to);
      if (parent && fromName && fileOrder[parent]) {
        const nextOrder = fileOrder[parent].map((name) => (name === fromName ? value : name));
        await persistFileOrder(parent, nextOrder);
      }
      if (entry?.type === 'dir' && fileOrder[from]) {
        await persistFileOrder(to, fileOrder[from]);
        await persistFileOrder(from, []);
      }
      await refreshTree();
      setInlineEdit(null);
      return;
    }

    const parent = inlineEdit.parent;
    const target = parent ? `${parent}/${value}` : value;
    if (inlineEdit.kind === 'new-folder') {
      await createFolderApi(projectId, target);
      if (fileOrder[parent]) {
        await persistFileOrder(parent, [...fileOrder[parent], value]);
      }
    } else {
      await writeFileCompat(target, '');
      if (isTextFile(target)) {
        await openFile(target);
      }
      if (fileOrder[parent]) {
        await persistFileOrder(parent, [...fileOrder[parent], value]);
      }
    }
    await refreshTree();
    setInlineEdit(null);
  };

  const cancelInlineEdit = () => setInlineEdit(null);

  const moveFileWithOrder = async (fromPath: string, folderPath: string, beforeName?: string) => {
    if (!projectId || !fromPath) return;
    const fileName = fromPath.split('/').pop();
    if (!fileName) return;
    const target = folderPath ? `${folderPath}/${fileName}` : fileName;
    if (target === fromPath) return;
    await drafts.exclusive(async () => {
      await renamePath(projectId, fromPath, target);
      drafts.rename(fromPath, target);
    });
    if (activePath === fromPath) {
      setActivePath(target);
      activePathRef.current = target;
    }
    setSelectedPath(target);

    const fromParent = getParentPath(fromPath);
    if (fromParent && fileOrder[fromParent]) {
      await persistFileOrder(fromParent, fileOrder[fromParent].filter((name) => name !== fileName));
    }

    const targetNode = folderPath ? findTreeNode(treeRoot, folderPath) : treeRoot;
    const childNames = targetNode ? targetNode.children.map((child) => child.name) : [];
    const baseOrder = (fileOrder[folderPath] || []).filter((name) => childNames.includes(name) && name !== fileName);
    childNames.forEach((name) => {
      if (!baseOrder.includes(name) && name !== fileName) baseOrder.push(name);
    });
    const insertIndex = beforeName && baseOrder.includes(beforeName) ? baseOrder.indexOf(beforeName) : baseOrder.length;
    const nextOrder = [...baseOrder];
    nextOrder.splice(insertIndex, 0, fileName);
    await persistFileOrder(folderPath, nextOrder);

    await refreshTree();
  };

  const updateDragHint = useCallback((text: string, event: DragEvent) => {
    const host = fileTreeRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = Math.min(rect.width - 12, Math.max(8, event.clientX - rect.left));
    const y = Math.min(rect.height - 12, Math.max(8, event.clientY - rect.top));
    setDragHint({ text, x, y });
  }, []);

  const persistFileOrder = useCallback(
    async (folder: string, order: string[]) => {
      if (!projectId) return;
      setFileOrder((prev) => ({ ...prev, [folder]: order }));
      try {
        await updateFileOrder(projectId, folder, order);
      } catch (err) {
        setStatus(t('保存排序失败: {{error}}', { error: String(err) }));
      }
    },
    [projectId, t]
  );

  const filteredTreeItems = useMemo(() => {
    const term = fileFilter.trim().toLowerCase();
    if (!term) return tree;
    return tree.filter((item) => item.path.toLowerCase().includes(term));
  }, [tree, fileFilter]);

  const treeRoot = useMemo(() => buildTree(filteredTreeItems, fileOrder), [filteredTreeItems, fileOrder]);

  const reorderWithinFolder = useCallback(
    async (fromPath: string, targetPath: string) => {
      if (fileFilter.trim()) return false;
      const fromParent = getParentPath(fromPath);
      const targetParent = getParentPath(targetPath);
      if (fromParent !== targetParent) return false;
      const fromName = fromPath.split('/').pop();
      const targetName = targetPath.split('/').pop();
      if (!fromName || !targetName || fromName === targetName) return false;
      const node = findTreeNode(treeRoot, fromParent);
      if (!node) return false;
      const currentNames = node.children.map((child) => child.name);
      const baseOrder = (fileOrder[fromParent] || []).filter((name) => currentNames.includes(name));
      currentNames.forEach((name) => {
        if (!baseOrder.includes(name)) baseOrder.push(name);
      });
      const nextOrder = baseOrder.filter((name) => name !== fromName);
      const targetIndex = nextOrder.indexOf(targetName);
      const insertIndex = targetIndex === -1 ? nextOrder.length : targetIndex;
      nextOrder.splice(insertIndex, 0, fromName);
      await persistFileOrder(fromParent, nextOrder);
      return true;
    },
    [fileOrder, persistFileOrder, treeRoot]
  );

  const texFiles = useMemo(
    () => tree.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.tex')).map((item) => item.path),
    [tree]
  );

  const bibFiles = useMemo(
    () => tree.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.bib')).map((item) => item.path),
    [tree]
  );

  const translateTargetOptions = useMemo(
    () => [
      { value: 'English', label: t('English') },
      { value: '中文', label: t('中文') },
      { value: '日本語', label: t('日本語') },
      { value: '한국어', label: t('한국어') },
      { value: 'Français', label: t('Français') },
      { value: 'Deutsch', label: t('Deutsch') },
      { value: 'Español', label: t('Español') }
    ],
    [t]
  );

  const outlineItems = useMemo(() => {
    if (!outlineText || !mainFile || !mainFile.toLowerCase().endsWith('.tex')) return [];
    return parseOutline(outlineText);
  }, [outlineText, mainFile]);

  useEffect(() => {
    if (!mainFile) {
      setOutlineText('');
      return;
    }
    if (activePath === mainFile) {
      setOutlineText(editorValue);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const content = await ensureFileContent(mainFile);
        if (!cancelled) setOutlineText(content);
      } catch {
        if (!cancelled) setOutlineText('');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activePath, editorValue, ensureFileContent, mainFile]);

  useEffect(() => {
    if (!visionFile) {
      setVisionPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(visionFile);
    setVisionPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [visionFile]);

  useEffect(() => {
    if (texFiles.length === 0) return;
    if (!texFiles.includes(mainFile)) {
      const preferred = texFiles.find((path) => path.endsWith('main.tex')) || texFiles[0];
      setMainFile(preferred);
    }
  }, [texFiles, mainFile]);

  useEffect(() => {
    if (citeTargetFile) return;
    if (mainFile) {
      setCiteTargetFile(mainFile);
    } else if (texFiles.length > 0) {
      setCiteTargetFile(texFiles[0]);
    }
  }, [citeTargetFile, mainFile, texFiles]);

  useEffect(() => {
    if (websearchTargetFile) return;
    if (mainFile) {
      setWebsearchTargetFile(mainFile);
    } else if (texFiles.length > 0) {
      setWebsearchTargetFile(texFiles[0]);
    }
  }, [websearchTargetFile, mainFile, texFiles]);

  useEffect(() => {
    if (websearchTargetBib) return;
    if (bibFiles.length > 0) {
      setWebsearchTargetBib(bibFiles[0]);
    }
  }, [bibFiles, websearchTargetBib]);

  useEffect(() => {
    if (!bibTarget && bibFiles.length > 0) {
      setBibTarget(bibFiles[0]);
    }
  }, [bibFiles, bibTarget]);

  const setAllFolders = useCallback(
    (open: boolean) => {
      const next: Record<string, boolean> = {};
      const walk = (nodes: TreeNode[]) => {
        nodes.forEach((node) => {
          if (node.type === 'dir') {
            next[node.path] = open;
            walk(node.children);
          }
        });
      };
      walk(treeRoot.children);
      setOpenFolders(next);
    },
    [treeRoot]
  );

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => ({ ...prev, [path]: !prev[path] }));
    setSelectedPath(path);
  };

  const handleFileSelect = async (path: string) => {
    setSelectedPath(path);
    if (isFigureFile(path)) {
      setSelectedFigure(path);
      setRightView('figures');
      return;
    }
    if (!isTextFile(path)) {
      setStatus(t('该文件为二进制文件，暂不支持直接编辑。'));
      return;
    }
    await openFile(path);
  };

  const inlineInputRow = (depth: number) => {
    if (!inlineEdit) return null;
    const paddingLeft = 8 + depth * 14;
    const isFolder = inlineEdit.kind === 'new-folder';
    return (
      <div className="tree-node">
        <div className={`tree-row ${isFolder ? 'folder' : 'file'} inline`} style={{ paddingLeft: paddingLeft + 14 }}>
          <input
            className="inline-input"
            autoFocus
            value={inlineEdit.value}
            onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmInlineEdit().catch((err) => setStatus(t('操作失败: {{error}}', { error: String(err) })));
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelInlineEdit();
              }
            }}
            onBlur={() => cancelInlineEdit()}
            placeholder={isFolder ? t('新建文件夹') : t('新建文件')}
          />
        </div>
      </div>
    );
  };

  const jumpToError = async (error: CompileError) => {
    const view = cmViewRef.current;
    const targetFile = error.file
      ? resolveCompileFile(error.file, tree.filter((item) => item.type === 'file').map((item) => item.path))
      : undefined;
    if (!targetFile || !error.line || !Number.isSafeInteger(error.line) || error.line < 1) return;
    if (!Object.prototype.hasOwnProperty.call(compiledSources, targetFile)) {
      setStatus(t('无法核对错误对应的源码，请重新编译后定位。'));
      return;
    }
    let content = '';
    try {
      content = targetFile === activePath ? editorValue : await openFile(targetFile);
    } catch {
      return;
    }
    if (draftsRef.current !== drafts || activePathRef.current !== targetFile || cmViewRef.current !== view) return;
    if (!view || content !== compiledSources[targetFile] || view.state.doc.toString() !== content) {
      setStatus(t('源码已变化或尚未加载，请重新编译后定位。'));
      return;
    }
    if (error.line <= view.state.doc.lines) {
      const offset = findLineOffset(content, error.line);
      view.dispatch({
        selection: { anchor: offset, head: offset },
        scrollIntoView: true
      });
      view.focus();
    }
  };

  const renderTree = (nodes: TreeNode[], depth = 0) =>
    nodes.map((node) => {
      const isDir = node.type === 'dir';
      const isOpen = openFolders[node.path] ?? depth < 1;
      const isActive = activePath === node.path;
      const isSelected = selectedPath === node.path;
      const isDragOver = dragOverPath === node.path;
      const paddingLeft = 8 + depth * 14;

      if (isDir) {
        return (
          <div key={node.path} className="tree-node">
            <button
              className={`tree-row folder ${isOpen ? 'open' : ''} ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{ paddingLeft }}
              onClick={() => toggleFolder(node.path)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverPath(node.path);
                setDragOverKind('folder');
                if (draggingPath) {
                  updateDragHint(t('移动到 {{name}} 文件夹', { name: node.name }), event);
                }
              }}
              onDragLeave={() => {
                setDragOverPath('');
                setDragOverKind('');
                setDragHint(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                  handleUpload(event.dataTransfer.files, node.path).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                  setDragOverPath('');
                  setDragOverKind('');
                  setDragHint(null);
                  return;
                }
                const from = event.dataTransfer.getData('text/plain');
                setDragOverPath('');
                setDragOverKind('');
                setDragHint(null);
                if (from) {
                  if (fileFilter.trim()) {
                    setStatus(t('搜索过滤中无法拖拽移动。'));
                    return;
                  }
                  moveFileWithOrder(from, node.path).catch((err) => setStatus(t('移动失败: {{error}}', { error: String(err) })));
                }
              }}
            >
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="tree-icon folder" />
              {inlineEdit?.kind === 'rename' && inlineEdit.path === node.path ? (
                <input
                  className="inline-input"
                  autoFocus
                  value={inlineEdit.value}
                  onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
                  onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    confirmInlineEdit().catch((err) => setStatus(t('操作失败: {{error}}', { error: String(err) })));
                  }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelInlineEdit();
                    }
                  }}
                  onBlur={() => cancelInlineEdit()}
                />
              ) : (
                <span className="tree-label">{node.name}</span>
              )}
            </button>
            {isOpen && (
              <div className="tree-children">
                {renderTree(node.children, depth + 1)}
                {inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.parent === node.path && inlineInputRow(depth + 1)}
              </div>
            )}
          </div>
        );
      }

      return (
        <button
          key={node.path}
          className={`tree-row file ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isDragOver ? (dragOverKind === 'file' ? 'drag-over-file' : 'drag-over') : ''} ${draggingPath === node.path ? 'dragging' : ''}`}
          style={{ paddingLeft: paddingLeft + 14 }}
          onClick={() => handleFileSelect(node.path)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('text/plain', node.path);
            setDraggingPath(node.path);
          }}
          onDragEnd={() => {
            setDraggingPath('');
            setDragHint(null);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOverPath(node.path);
            setDragOverKind('file');
            if (draggingPath) {
              const targetParent = getParentPath(node.path);
              const fromParent = getParentPath(draggingPath);
              const parentLabel = targetParent || t('根目录');
              const hint =
                fromParent === targetParent
                  ? t('插入到 {{name}} 前', { name: node.name })
                  : t('移动到 {{parent}} 并插入到 {{name}} 前', { parent: parentLabel, name: node.name });
              updateDragHint(hint, event);
            }
          }}
          onDragLeave={() => {
            setDragOverPath('');
            setDragOverKind('');
            setDragHint(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const from = event.dataTransfer.getData('text/plain');
            setDragOverPath('');
            setDragOverKind('');
            setDragHint(null);
            if (!from) return;
            if (fileFilter.trim()) {
              setStatus(t('搜索过滤中无法拖拽排序。'));
              return;
            }
            const targetParent = getParentPath(node.path);
            const fromParent = getParentPath(from);
            if (fromParent === targetParent) {
              reorderWithinFolder(from, node.path).catch((err) => setStatus(t('排序失败: {{error}}', { error: String(err) })));
              return;
            }
            moveFileWithOrder(from, targetParent, node.name).catch((err) => setStatus(t('移动失败: {{error}}', { error: String(err) })));
          }}
        >
          <span className={`tree-icon file ext-${getFileTypeLabel(node.path).toLowerCase()}`}>{getFileTypeLabel(node.path)}</span>
          {inlineEdit?.kind === 'rename' && inlineEdit.path === node.path ? (
            <input
              className="inline-input"
              autoFocus
              value={inlineEdit.value}
              onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
              onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmInlineEdit().catch((err) => setStatus(t('操作失败: {{error}}', { error: String(err) })));
              }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelInlineEdit();
                }
              }}
              onBlur={() => cancelInlineEdit()}
            />
          ) : (
            <span className="tree-label">{node.name}</span>
          )}
          {isFigureFile(node.path) && <span className="tree-tag">FIG</span>}
          {node.path.endsWith('.bib') && <span className="tree-tag">BIB</span>}
        </button>
      );
    });

  const compile = () => compileDocument({
    mainFile, engine: compileEngine, activePath, editorValue,
    save: () => saveActiveFile({ silent: true, throwOnError: true }),
    onStatus: setStatus, onView: setRightView
  });

  const selectionText = useMemo(() => {
    const [start, end] = selectionRange;
    if (start === end) return '';
    return editorValue.slice(start, end);
  }, [selectionRange, editorValue]);

  useEffect(() => {
    const view = cmViewRef.current;
    if (!view) return;
    const currentErrors = Object.prototype.hasOwnProperty.call(compiledSources, activePath) && compiledSources[activePath] === editorValue
      ? compileErrors.map((error) => ({
        ...error,
        file: error.file ? resolveCompileFile(error.file, Object.keys(compiledSources)) : undefined
      }))
      : [];
    view.dispatch(setDiagnostics(view.state, compileDiagnostics(currentErrors, activePath, editorValue)));
  }, [compileErrors, compiledSources, activePath, editorValue]);
  const pendingGrouped = pendingChanges;

  const figureFiles = useMemo(
    () =>
      tree.filter(
        (item) =>
          item.type === 'file' &&
          FIGURE_EXTS.some((ext) => item.path.toLowerCase().endsWith(ext))
      ),
    [tree]
  );

  useEffect(() => {
    if (!selectedFigure && figureFiles.length > 0) {
      setSelectedFigure(figureFiles[0].path);
    }
  }, [figureFiles, selectedFigure]);

  useEffect(() => {
    setPdfAnnotations([]);
    setPdfOutline([]);
  }, [pdfUrl]);

  const pdfScaleLabel = useMemo(() => {
    if (pdfFitWidth) {
      const fitValue = pdfFitScale ?? pdfScale;
      return t('Fit · {{percent}}%', { percent: Math.round(fitValue * 100) });
    }
    return `${Math.round(pdfScale * 100)}%`;
  }, [pdfFitScale, pdfFitWidth, pdfScale, t]);

  const breadcrumbParts = useMemo(() => (activePath ? activePath.split('/').filter(Boolean) : []), [activePath]);

  const clampPdfScale = useCallback((value: number) => Math.min(2.5, Math.max(0.6, value)), []);

  const zoomPdf = useCallback(
    (delta: number) => {
      const base = pdfFitScale ?? pdfScale;
      setPdfFitWidth(false);
      setPdfScale(clampPdfScale(base + delta));
    },
    [clampPdfScale, pdfFitScale, pdfScale]
  );

  const scrollToPdfPage = useCallback((page: number) => {
    const container = pdfContainerRef.current;
    if (!container || !page) return;
    const target = container.querySelector(`.pdf-page[data-page-number="${page}"]`) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const handlePdfOutline = useCallback((items: { title: string; page?: number; level: number }[]) => {
    setPdfOutline(items);
  }, []);

  const addPdfAnnotation = useCallback((page: number, x: number, y: number) => {
    const text = window.prompt(t('输入注释内容'))?.trim();
    if (!text) return;
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setPdfAnnotations((prev) => [...prev, { id, page, x, y, text }]);
  }, [t]);

  const downloadPdf = useCallback(() => {
    if (!pdfUrl) return;
    const name = projectName ? projectName.replace(/\s+/g, '-') : projectId || 'scienceprism';
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = `${name}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [pdfUrl, projectId, projectName]);

  const handleFitScale = useCallback((value: number | null) => {
    if (value == null) {
      setPdfFitScale(null);
      return;
    }
    setPdfFitScale((prev) => (prev && Math.abs(prev - value) < 0.005 ? prev : value));
  }, []);

  const prepareAssistantDocuments = async () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    await saveActiveFile({ silent: true, throwOnError: true });
    return drafts.versions();
  };

  const sendAssistant = async (intent: AssistantIntent) => {
    const accepted = await assistant.start({
      ...intent, activePath, compileLog, llmConfig, history: assistant.history
    }, prepareAssistantDocuments);
    if (accepted) { setActiveSidebar('agent'); setSidebarOpen(true); }
    return accepted;
  };

  const retryAssistant = async (run: HarnessRun) => {
    const request = run.request;
    if (!request) return;
    await assistant.start({
      task: request.task || run.task, prompt: request.prompt || '',
      permission: request.permission || 'edit', activePath: request.activePath,
      selection: '', compileLog: run.task === 'debug_compile' ? compileLog : request.compileLog,
      history: request.history, skillNames: request.skillNames, llmConfig
    }, prepareAssistantDocuments);
  };

  const diagnoseCompile = async () => {
    if (!compileLog || !activePath) return;
    await sendAssistant({ task: 'debug_compile', permission: 'edit',
      prompt: t('基于编译日志诊断并修复错误，给出可审阅的修改。') });
  };

  const applyReviewedChanges = async (work: () => Promise<void>, changes: PendingChange[]) => {
    await drafts.exclusive(async () => {
      const before = new Map<string, string | undefined>();
      for (const change of changes) {
        const draft = drafts.get(change.filePath);
        const live = change.filePath === activePathRef.current ? cmViewRef.current?.state.doc.toString() : draft?.content;
        if (draft && live !== draft.saved) throw new Error(t('存在未保存的新内容，请先保存再审阅：{{path}}', { path: change.filePath }));
        before.set(change.filePath, live);
      }
      try { await work(); }
      finally {
        for (const filePath of before.keys()) {
          const currentContent = () => filePath === activePathRef.current ? cmViewRef.current?.state.doc.toString() : drafts.get(filePath)?.content;
          if (currentContent() !== before.get(filePath)) continue;
          const stored = await getFile(projectId, filePath).catch(() => null);
          if (currentContent() !== before.get(filePath)) continue;
          if (!stored) {
            const { items } = await getProjectTree(projectId);
            if (items.some((item) => item.path === filePath) || currentContent() !== before.get(filePath)) continue;
            drafts.forget(filePath);
            setFiles((previous) => { const next = { ...previous }; delete next[filePath]; return next; });
            if (activePathRef.current === filePath) {
              setActivePath(''); activePathRef.current = ''; setEditorValue(''); setEditorDoc('');
            }
          } else {
            drafts.loaded(filePath, stored.content, stored.version);
            setFiles((previous) => ({ ...previous, [filePath]: stored.content }));
            if (activePathRef.current === filePath && !collabActiveRef.current) {
              setEditorValue(stored.content); setEditorDoc(stored.content); setIsDirty(false);
            }
          }
        }
      }
    });
    await refreshTree();
  };

  const applyPending = async (change?: PendingChange) => {
    if (await changeReview.review(change ? [change] : pendingChanges, 'accept', applyReviewedChanges)) {
      setDiffFocus(null); setStatus(t('已应用修改'));
    }
  };

  const discardPending = async (change?: PendingChange) => {
    if (await changeReview.review(change ? [change] : pendingChanges, 'reject', applyReviewedChanges)) setDiffFocus(null);
  };

  const startColumnDrag = useCallback(
    (side: 'left' | 'right', event: ReactMouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const { sidebar, editor, right } = columnSizes;
      const minSidebar = 220;
      const minEditor = 360;
      const minRight = 320;

      const onMove = (moveEvent: globalThis.MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        if (side === 'left') {
          const nextSidebar = Math.max(minSidebar, sidebar + dx);
          const nextEditor = Math.max(minEditor, editor - dx);
          setColumnSizes({ sidebar: nextSidebar, editor: nextEditor, right });
        } else {
          const nextEditor = Math.max(minEditor, editor + dx);
          const nextRight = Math.max(minRight, right - dx);
          setColumnSizes({ sidebar, editor: nextEditor, right: nextRight });
        }
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [columnSizes]
  );

  const startEditorSplitDrag = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      const container = editorSplitRef.current;
      if (!container) return;

      const onMove = (moveEvent: globalThis.MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const offsetY = moveEvent.clientY - rect.top;
        const ratio = Math.min(0.85, Math.max(0.35, offsetY / rect.height));
        setEditorSplit(ratio);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    []
  );

  return (
    <div className={`app-shell workspace-shell${researchMode ? ' is-research' : ' is-writing'}`}>
      <ProjectWorkspaceNav projectId={projectId} projectName={projectName} active={researchMode ? 'research' : 'writing'} />
      {researchMode ? <header className="research-command-bar"><span>{t('研究工作区')}</span><div><button className="btn ghost" onClick={() => navigate(`/project/${projectId}/tasks`)}>{t('任务进度')}</button><button className="btn ghost" aria-pressed={researchContextOpen} onClick={() => setResearchContextOpen((open) => !open)}><PanelRight size={16} />{t('研究上下文')}</button></div></header> : <header className="top-bar">
        <div className="editor-titlebar">
          <button className="icon-btn" onClick={() => setSidebarOpen((prev) => !prev)} title={sidebarOpen ? t('隐藏侧栏') : t('显示侧栏')} aria-label={sidebarOpen ? t('隐藏侧栏') : t('显示侧栏')}>
            <PanelLeft size={17} />
          </button>
        </div>
        <div className="toolbar">
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={(e) => {
              const opening = !mainFileDropdownOpen;
              setMainFileDropdownOpen(opening); setEngineDropdownOpen(false); setLangDropdownOpen(false);
              if (opening) { const r = e.currentTarget.getBoundingClientRect(); setTopBarDropdownRect({ top: r.bottom + 6, left: r.left, width: r.width }); }
            }}>
              <span>{mainFile}</span>
              <ChevronDown size={14} className={mainFileDropdownOpen ? 'rotate' : ''} />
            </button>
          </div>
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={(e) => {
              const opening = !engineDropdownOpen;
              setEngineDropdownOpen(opening); setMainFileDropdownOpen(false); setLangDropdownOpen(false);
              if (opening) { const r = e.currentTarget.getBoundingClientRect(); setTopBarDropdownRect({ top: r.bottom + 6, left: r.left, width: r.width }); }
            }}>
              <span>{({'pdflatex':'pdfLaTeX','xelatex':'XeLaTeX','lualatex':'LuaLaTeX','latexmk':'Latexmk','tectonic':'Tectonic'} as Record<string,string>)[compileEngine] || compileEngine}</span>
              <ChevronDown size={14} className={engineDropdownOpen ? 'rotate' : ''} />
            </button>
          </div>
          <button onClick={() => void saveActiveFile()} className="icon-btn" title={t('保存')} aria-label={t('保存')}><Save size={17} /></button>
          <button onClick={isCompiling ? () => {
            abandonWait();
            setRightView('log');
            setStatus(t('已退出等待；服务端可能仍在运行，请到任务中心查看或取消。'));
          } : compile} className="editor-compile-button" title={isCompiling ? t('只退出等待，不停止服务端编译；可到任务中心取消。') : t('编译')}>
            {isCompiling ? <X size={15} /> : <Play size={15} />}{isCompiling ? t('退出等待') : t('编译')}
          </button>
          {researchMode && <button className={`icon-btn${researchContextOpen ? ' active' : ''}`} onClick={() => setResearchContextOpen((open) => !open)} title={t('研究上下文')} aria-label={t('研究上下文')}><PanelRight size={17} /></button>}
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title={t('设置')} aria-label={t('设置')}><SettingsIcon size={17} /></button>
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={(e) => {
              const opening = !langDropdownOpen;
              setLangDropdownOpen(opening); setMainFileDropdownOpen(false); setEngineDropdownOpen(false);
              if (opening) { const r = e.currentTarget.getBoundingClientRect(); setTopBarDropdownRect({ top: r.bottom + 6, left: r.left, width: r.width }); }
            }}>
              <Languages size={15} />
              <span>{i18n.language === 'zh-CN' ? t('中文') : t('English')}</span>
              <ChevronDown size={14} className={langDropdownOpen ? 'rotate' : ''} />
            </button>
          </div>
        </div>
      </header>}

      {!researchMode && <div className="status-bar">
        <div className="status-left">
          <div>{status}</div>
          <div className={`save-indicator ${isSaving ? 'saving' : isDirty ? 'dirty' : 'saved'} ${savePulse ? 'pulse' : ''}`}>
            <span className="dot" />
            <span>{isSaving ? t('保存中...') : isDirty ? t('未保存') : t('已保存')}</span>
          </div>
        </div>
        <div className="status-right">
          {t('Compile')}: {compileEngine} · {t('Engine')}: {engineName || t('未初始化')}
        </div>
      </div>}

      {researchMode && <div className="workspace-stage-strip"><ResearchStageNavigation activeStage={activeResearchStage} stageStatuses={researchWorkspaceState?.stageStatuses} onNavigate={(nextStage) => navigate(`/editor/${projectId}/research/${nextStage}`)} /></div>}

      <main
        className={`workspace${researchMode ? ' research-mode' : ''}${researchMode && !researchContextOpen ? ' context-closed' : ''}`}
        ref={gridRef}
        style={{
          '--col-sidebar': sidebarOpen ? `${columnSizes.sidebar}px` : '0px',
          '--col-sidebar-gap': sidebarOpen ? '10px' : '0px',
          '--col-editor': `${columnSizes.editor}px`,
          '--col-right': researchMode && !researchContextOpen ? '0px' : `${columnSizes.right}px`
        } as CSSProperties}
      >
        {!researchMode && sidebarOpen && (
          <aside className="panel side-panel">
            <div className="sidebar-tabs">
              <div className="tab-group">
                <button
                  className={`tab-btn ${activeSidebar === 'research' ? 'active' : ''}`}
                  data-testid="research-sidebar-tab"
                  onClick={() => {
                    setActiveSidebar('research');
                    setSidebarOpen(true);
                    if (!researchMode) navigate(researchHref(projectId));
                  }}
                  title="研究流程"
                >
                  <span className="tab-icon"><FlaskConical size={15} /></span>
                  <span className="tab-text">研究流程</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'files' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('files')}
                  title={t('Files')}
                >
                  <span className="tab-icon"><FolderTree size={15} /></span>
                  <span className="tab-text">{t('Files')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'agent' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('agent')}
                  title={t('助手')}
                >
                  <span className="tab-icon"><Bot size={15} /></span>
                  <span className="tab-text">{t('助手')}</span>
                </button>
                <div className="assistant-tool-menu">
                  <button
                    className={`tab-btn ${['vision', 'search', 'websearch', 'plot', 'review'].includes(activeSidebar) ? 'active' : ''}`}
                    type="button"
                    title={t('更多助手工具')}
                  >
                    <span className="tab-icon"><ChevronDown size={14} /></span>
                    <span className="tab-text">{t('更多')}</span>
                  </button>
                  <div className="assistant-tool-popover">
                    <button onClick={() => setActiveSidebar('vision')}><ImageIcon size={15} />{t('图像识别')}</button>
                    <button onClick={() => setActiveSidebar('search')}><SearchIcon size={15} />{t('论文检索')}</button>
                    <button onClick={() => setActiveSidebar('websearch')}><Globe2 size={15} />{t('网页检索')}</button>
                    <button onClick={() => setActiveSidebar('plot')}><BarChart3 size={15} />{t('绘图')}</button>
                    <button onClick={() => setActiveSidebar('review')}><CheckCircle2 size={15} />{t('评审')}</button>
                  </div>
                </div>
                <button
                  className={`tab-btn ${activeSidebar === 'collab' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('collab')}
                  title={t('协作')}
                >
                  <span className="tab-icon"><Users size={15} /></span>
                  <span className="tab-text">{t('协作')}</span>
                </button>
              </div>
              <button className="icon-btn" onClick={() => setSidebarOpen(false)} title={t('关闭侧栏')} aria-label={t('关闭侧栏')}><X size={15} /></button>
            </div>
            {activeSidebar === 'research' ? (
              <>
                <div className="panel-header">
                  <div>研究流程</div>
                  <span className={`research-sidebar-harness is-${researchWorkspaceState?.harnessState || 'checking'}`}>
                    {researchWorkspaceState?.harnessState === 'ready' ? 'Harness 已连接' : researchWorkspaceState?.harnessState === 'unavailable' ? 'Harness 未配置' : 'Harness 检查中'}
                  </span>
                </div>
                <div className="research-sidebar-integrated" data-testid="research-stage-nav">
                  <ResearchStageNavigation
                    activeStage={activeResearchStage}
                    stageStatuses={researchWorkspaceState?.stageStatuses}
                    onNavigate={(nextStage) => navigate(`/editor/${projectId}/research/${nextStage}`)}
                  />
                  <div className="research-sidebar-gate-note">
                    <strong>人工确认门禁</strong>
                    <span>AI 负责补充与执行建议，每一阶段由你输入并确认。</span>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'files' ? (
              <>
                <div className="panel-header">
                  <div>{t('Project Files')}</div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    handleUpload(event.target.files).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                    if (event.target) {
                      event.target.value = '';
                    }
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
                  onChange={(event) => {
                    handleUpload(event.target.files).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                    if (event.target) {
                      event.target.value = '';
                    }
                  }}
                />
                <div className="panel-search">
                  <input
                    className="input"
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder={t('搜索文件...')}
                  />
                </div>
                <div className="drag-hint muted">{t('拖拽文件：同级排序 / 跨文件夹移动')}</div>
                <div
                  className="file-tree-body"
                  ref={fileTreeRef}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const menuH = 380;
                    const menuW = 180;
                    const y = event.clientY + menuH > window.innerHeight ? Math.max(8, window.innerHeight - menuH - 8) : event.clientY;
                    const x = event.clientX + menuW > window.innerWidth ? Math.max(8, window.innerWidth - menuW - 8) : event.clientX;
                    setFileContextMenu({ x, y });
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverPath('');
                    setDragOverKind('');
                    if (draggingPath) {
                      updateDragHint(t('移动到 根目录'), event);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                      handleUpload(event.dataTransfer.files).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                      return;
                    }
                    const from = event.dataTransfer.getData('text/plain');
                    if (from) {
                      if (fileFilter.trim()) {
                        setStatus(t('搜索过滤中无法拖拽移动。'));
                        return;
                      }
                      moveFileWithOrder(from, '').catch((err) => setStatus(t('移动失败: {{error}}', { error: String(err) })));
                    }
                    setDragHint(null);
                  }}
                >
                  {dragHint && draggingPath && (
                    <div className="drag-hint-overlay" style={{ left: dragHint.x, top: dragHint.y }}>
                      {dragHint.text}
                    </div>
                  )}
                  {inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.parent === '' && inlineInputRow(0)}
                  {renderTree(treeRoot.children)}
                </div>
                <div className="outline-panel">
                  <div className="outline-header" onClick={() => setOutlineCollapsed(!outlineCollapsed)} style={{ cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: outlineCollapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }}>
                        <path d="M2 3L5 6L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      {t('Outline')}
                    </div>
                    <div className="muted">{mainFile || 'main.tex'}</div>
                  </div>
                  {!outlineCollapsed && (mainFile && mainFile.toLowerCase().endsWith('.tex') ? (
                    outlineItems.length > 0 ? (
                      <div className="outline-list">
                        {outlineItems.map((item, idx) => (
                          <button
                            key={`${item.pos}-${idx}`}
                            className={`outline-item level-${item.level}`}
                            onClick={() => {
                              const go = async () => {
                                if (mainFile && activePath !== mainFile) {
                                  await openFile(mainFile);
                                }
                                const view = cmViewRef.current;
                                if (!view) return;
                                const pos = Math.min(item.pos, view.state.doc.length);
                                view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
                                view.focus();
                              };
                              go();
                            }}
                          >
                            <span className="outline-title">{item.title}</span>
                            <span className="outline-line">L{item.line}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="muted outline-empty">{t('未发现 Section 标题。')}</div>
                    )
                  ) : (
                    <div className="muted outline-empty">{t('打开 .tex 文件以显示 Outline。')}</div>
                  ))}
                </div>
              </>
            ) : activeSidebar === 'collab' ? (
              <CollaborationPanel
                collabStatus={collabStatus}
                collabServer={collabServer}
                setCollabServerState={setCollabServerState}
                collabName={collabName}
                setCollabName={setCollabName}
                collabEnabled={collabEnabled}
                onToggleConnection={() => setCollabEnabled((previous) => !previous)}
                canConnect={Boolean(activePath && isTextPath(activePath))}
                canInvite={Boolean(projectId)}
                collabInviteBusy={collabInviteBusy}
                handleCreateInvite={handleCreateInvite}
                copyInviteLink={copyInviteLink}
                collabInviteLink={collabInviteLink}
                activePath={activePath}
                collabPeers={collabPeers}
              />
            ) : activeSidebar === 'agent' ? (
              <AssistantPanel key={projectId} projectId={projectId} assistant={assistant}
                activePath={activePath} selection={selectionText} onSend={sendAssistant}
                onRetry={(run) => void retryAssistant(run)} onReview={() => setRightView('diff')} />
            ) : activeSidebar === 'vision' ? (
              <VisionPanel
                visionMode={visionMode}
                setVisionMode={setVisionMode}
                visionFile={visionFile}
                setVisionFile={setVisionFile}
                visionResult={visionResult}
                setVisionResult={setVisionResult}
                visionPreviewUrl={visionPreviewUrl}
                setVisionPreviewUrl={setVisionPreviewUrl}
                visionPrompt={visionPrompt}
                setVisionPrompt={setVisionPrompt}
                visionBusy={visionBusy}
                handleVisionSubmit={handleVisionSubmit}
                handleVisionInsert={handleVisionInsert}
              />
            ) : activeSidebar === 'search' ? (
              <LiteratureSearchPanel
                arxivQuery={arxivQuery}
                setArxivQuery={setArxivQuery}
                arxivMaxResults={arxivMaxResults}
                setArxivMaxResults={setArxivMaxResults}
                handleArxivSearch={handleArxivSearch}
                arxivBusy={arxivBusy}
                useLlmSearch={useLlmSearch}
                setUseLlmSearch={setUseLlmSearch}
                arxivStatus={arxivStatus}
                llmSearchOutput={llmSearchOutput}
                setLlmSearchOutput={setLlmSearchOutput}
                arxivResults={arxivResults}
                arxivSelected={arxivSelected}
                onSelectPaper={(id, selected) => setArxivSelected((previous) => ({ ...previous, [id]: selected }))}
                bibTarget={bibTarget}
                setBibTarget={setBibTarget}
                bibFiles={bibFiles}
                createBibFile={createBibFile}
                autoInsertCite={autoInsertCite}
                setAutoInsertCite={setAutoInsertCite}
                autoInsertToMain={autoInsertToMain}
                setAutoInsertToMain={setAutoInsertToMain}
                citeTargetFile={citeTargetFile}
                setCiteTargetFile={setCiteTargetFile}
                texFiles={texFiles}
                handleArxivApply={handleArxivApply}
              />
            ) : activeSidebar === 'websearch' ? (
              <>
                <div className="panel-header">
                  <div>{t('Websearch')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('多点检索')}</div>
                    <div className="field">
                      <label>{t('Query')}</label>
                      <input
                        className="input"
                        value={websearchQuery}
                        onChange={(event) => setWebsearchQuery(event.target.value)}
                        placeholder={t('例如: diffusion editing for safety')}
                      />
                    </div>
                    <div className="row">
                      <button className="btn" onClick={runWebsearch} disabled={websearchBusy}>
                        {websearchBusy ? t('检索中...') : t('开始检索')}
                      </button>
                    </div>
                    <div className="websearch-log">
                      {websearchLog.length === 0 ? (
                        <div className="muted">{t('等待查询...')}</div>
                      ) : (
                        websearchLog.map((line, idx) => (
                          <div key={idx} className="websearch-line">{line}</div>
                        ))
                      )}
                    </div>
                    {websearchResults.length > 0 && (
                      <>
                        <div className="row">
                          <label className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={websearchSelectedAll}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setWebsearchSelectedAll(checked);
                                const next: Record<string, boolean> = {};
                                websearchResults.forEach((item) => {
                                  next[item.id] = checked;
                                });
                                setWebsearchSelected(next);
                              }}
                            />
                            {t('全选')}
                          </label>
                          <button
                            className="btn ghost small"
                            onClick={() => {
                              const keys = websearchResults
                                .filter((item) => websearchSelected[item.id])
                                .map((item) => item.citeKey)
                                .filter(Boolean);
                              if (keys.length > 0) {
                                insertAtCursor(`\\cite{${keys.join(',')}}`);
                                appendLog(setWebsearchLog, t('已插入选中引用到光标。'));
                              }
                            }}
                          >
                            {t('插入选中引用')}
                          </button>
                        </div>
                        <div className="tool-list">
                          {websearchResults.map((paper) => (
                            <label key={paper.id} className="tool-item">
                              <input
                                type="checkbox"
                                checked={Boolean(websearchSelected[paper.id])}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setWebsearchSelected((prev) => ({ ...prev, [paper.id]: checked }));
                                }}
                              />
                              <div>
                                <div className="tool-item-title">{paper.title}</div>
                                {paper.summary && <div className="muted">{paper.summary}</div>}
                                {paper.url && <div className="muted">{paper.url}</div>}
                                {paper.citeKey && <div className="muted">{t('cite')}: {paper.citeKey}</div>}
                              </div>
                              <button
                                className="btn ghost small"
                                onClick={() => {
                                  if (paper.citeKey) {
                                    insertAtCursor(`\\cite{${paper.citeKey}}`);
                                    appendLog(setWebsearchLog, t('已插入: {{cite}}', { cite: paper.citeKey }));
                                  }
                                }}
                              >
                                {t('插入引用')}
                              </button>
                            </label>
                          ))}
                        </div>
                        <div className="vision-result">
                          <div className="muted">{t('逐条总结')}</div>
                          <div className="tool-list">
                            {websearchResults.map((paper) => (
                              <div key={paper.id} className="tool-item summary-item">
                                <div>
                                  <div className="tool-item-title">{paper.title}</div>
                                  {paper.citeKey && <div className="muted">{t('cite')}: {paper.citeKey}</div>}
                                </div>
                                <textarea
                                  className="input"
                                  value={websearchItemNotes[paper.id] ?? paper.summary ?? ''}
                                  onChange={(event) =>
                                    setWebsearchItemNotes((prev) => ({ ...prev, [paper.id]: event.target.value }))
                                  }
                                  rows={3}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    {websearchParagraph && (
                      <div className="vision-result">
                        <div className="muted">{t('综合总结')}</div>
                        <textarea
                          className="input"
                          value={websearchParagraph}
                          onChange={(event) => setWebsearchParagraph(event.target.value)}
                          rows={6}
                        />
                      </div>
                    )}
                    <div className="field">
                      <label>{t('Bib 文件')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => setWsBibDropdownOpen(!wsBibDropdownOpen)}>
                          <span>{websearchTargetBib || t('(新建/选择 Bib 文件)')}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={wsBibDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        {wsBibDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            <div className={`ios-dropdown-item ${!websearchTargetBib ? 'active' : ''}`} onClick={() => { setWebsearchTargetBib(''); setWsBibDropdownOpen(false); }}>
                              {t('(新建/选择 Bib 文件)')}
                              {!websearchTargetBib && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                            </div>
                            {bibFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${websearchTargetBib === p ? 'active' : ''}`} onClick={() => { setWebsearchTargetBib(p); setWsBibDropdownOpen(false); }}>
                                {p}
                                {websearchTargetBib === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="btn ghost small" onClick={async () => {
                        const created = await createBibFile();
                        if (created) setWebsearchTargetBib(created);
                      }}>{t('新建 Bib')}</button>
                    </div>
                    <div className="field">
                      <label>{t('插入目标 TeX')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => { setWsTexDropdownOpen(!wsTexDropdownOpen); setWsBibDropdownOpen(false); }}>
                          <span>{websearchTargetFile || '—'}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={wsTexDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {wsTexDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            {texFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${websearchTargetFile === p ? 'active' : ''}`} onClick={() => { setWebsearchTargetFile(p); setWsTexDropdownOpen(false); }}>
                                {p}
                                {websearchTargetFile === p && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="row">
                      <button className="btn" onClick={applyWebsearchInsert} disabled={websearchBusy}>
                        {t('一键写入 Bib + 插入总结')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'plot' ? (
              <PlotPanel
                projectId={projectId}
                plotType={plotType}
                plotTitle={plotTitle}
                plotFilename={plotFilename}
                plotPrompt={plotPrompt}
                plotRetries={plotRetries}
                plotAutoInsert={plotAutoInsert}
                plotBusy={plotBusy}
                plotStatus={plotStatus}
                plotAssetPath={plotAssetPath}
                imagePrompt={imagePrompt}
                imageSize={imageSize}
                imageQuality={imageQuality}
                imageBusy={imageBusy}
                imageStatus={imageStatus}
                imageAssetPath={imageAssetPath}
                setPlotType={setPlotType}
                setPlotTitle={setPlotTitle}
                setPlotFilename={setPlotFilename}
                setPlotPrompt={setPlotPrompt}
                setPlotRetries={setPlotRetries}
                setPlotAutoInsert={setPlotAutoInsert}
                setImagePrompt={setImagePrompt}
                setImageSize={setImageSize}
                setImageQuality={setImageQuality}
                handlePlotGenerate={handlePlotGenerate}
                handleGptImageGenerate={handleGptImageGenerate}
                insertFigureSnippet={insertFigureSnippet}
              />
            ) : activeSidebar === 'review' ? (
              <>
                <div className="panel-header">
                  <div>{t('Review')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('质量检查')}</div>
                    <div className="tool-desc">{t('AI 辅助检查论文质量，发现潜在问题')}</div>
                    <div className="review-buttons">
                      <button
                        className="review-btn"
                        onClick={async () => {
                          if (reviewReportBusy) return;
                          setReviewReportBusy(true);
                          setReviewReport(t('生成中...'));
                          setRightView('review');
                          try {
                            const res = await runAgent({
                              task: 'peer_review',
                              role: 'paper-reviewer',
                              prompt: t('Read all .tex files in the project (start from the main file and any included sections). Use list_files and read_file tools to inspect content. Write a detailed reviewer-style report. Include: Summary, Strengths, Weaknesses, Questions, Missing Experiments, Writing/Clarity, Suggestions, Score (1-10), and Confidence. Output report text only; do not propose patches or code.'),
                              selection: '',
                              content: '',
                              mode: 'tools',
                              projectId,
                              activePath,
                              compileLog,
                              llmConfig,
                              interaction: 'agent',
                              history: []
                            });
                            setReviewReport(res.reply || t('无结果'));
                          } catch (err) {
                            setReviewReport(t('生成失败: {{error}}', { error: String(err) }));
                          } finally {
                            setReviewReportBusy(false);
                          }
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg></span>
                        <span className="review-btn-label">{t('详细评审报告')}</span>
                        <span className="review-btn-desc">{t('阅读项目并输出完整审稿意见')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'consistency_check',
                            role: 'paper-reviewer',
                            prompt: `Read all .tex files in the project using list_files and read_file tools. Perform a thorough consistency check across the entire paper. Check the following dimensions:

1. **Terminology consistency**: Identify terms that refer to the same concept but use different wording (e.g., "feature extraction" vs "feature engineering", "model" vs "network" vs "architecture" used interchangeably).

2. **Notation consistency**: Check if mathematical symbols and notation are used consistently (e.g., bold for vectors vs non-bold, x vs X for the same variable, inconsistent subscript/superscript conventions).

3. **Data and results consistency**: Verify that numbers, statistics, and experimental results mentioned in the abstract, introduction, method, and conclusion sections are consistent with those in tables and figures.

4. **Logic and claim consistency**: Check if claims made in the introduction/conclusion are actually supported by the experiments. Flag contradictions between sections.

5. **Reference consistency**: Check for undefined abbreviations, references to figures/tables/sections that don't exist, or mislabeled cross-references.

6. **Tense and style consistency**: Flag inconsistent use of tense (e.g., mixing past and present when describing experiments) or perspective (e.g., "we" vs "the authors" vs passive voice).

For each issue found, report in this format:

---
**[Category]** Terminology / Notation / Data / Logic / Reference / Style
**[Location]** file and approximate line or section
**[Issue]** Describe the inconsistency
**[Suggestion]** How to fix it
---

Here are examples of good findings:

Example 1:
**[Terminology]**
**[Location]** sections/method.tex, Section 3.1 vs sections/experiments.tex, Section 4
**[Issue]** The method section calls the module "Spatial Attention Block" but the experiments section refers to it as "Spatial Attention Module".
**[Suggestion]** Unify to one term throughout the paper, e.g., "Spatial Attention Module".

Example 2:
**[Data]**
**[Location]** sections/abstract.tex vs sections/experiments.tex, Table 2
**[Issue]** The abstract claims "93.2% accuracy on CIFAR-10" but Table 2 reports 92.8%.
**[Suggestion]** Update the abstract to match the actual result in Table 2.

Example 3:
**[Logic]**
**[Location]** sections/introduction.tex, paragraph 3 vs sections/conclusion.tex, paragraph 1
**[Issue]** The introduction states the method "does not require pre-training" but the conclusion mentions "after pre-training on ImageNet".
**[Suggestion]** Clarify whether pre-training is used and make both sections consistent.

Example 4:
**[Notation]**
**[Location]** sections/method.tex, Eq. (3) vs Eq. (7)
**[Issue]** Eq. (3) uses bold lowercase h for hidden states, but Eq. (7) uses non-bold italic h for the same variable.
**[Suggestion]** Use bold h consistently for hidden state vectors.

Be thorough. Read ALL .tex files before reporting. Group findings by category. If no issues are found in a category, state that explicitly.`,
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('一致性检查'), content: res.reply || t('无结果') }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>
                        <span className="review-btn-label">{t('一致性检查')}</span>
                        <span className="review-btn-desc">{t('检查术语、符号一致性')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'missing_citations',
                            role: 'paper-reviewer',
                            prompt: t('Find claims that likely need citations and list them.'),
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('引用缺失'), content: res.reply || t('无结果') }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>
                        <span className="review-btn-label">{t('引用缺失')}</span>
                        <span className="review-btn-desc">{t('查找需要引用的论述')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'compile_summary',
                            prompt: t('Summarize compile log errors and suggested fixes.'),
                            selection: compileLog,
                            content: '',
                            mode: 'direct',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('编译日志总结'), content: res.reply || t('无结果') }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>
                        <span className="review-btn-label">{t('编译日志总结')}</span>
                        <span className="review-btn-desc">{t('总结错误并给出修复建议')}</span>
                      </button>
                    </div>
                  </div>
                  {reviewNotes.length > 0 && (
                    <div className="tool-section">
                      <div className="tool-title">{t('结果')}</div>
                      {reviewNotes.map((note, idx) => (
                        <div key={`${note.title}-${idx}`} className="review-item">
                          <div className="review-title">{note.title}</div>
                          <div className="review-content markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </aside>
        )}

        {!researchMode && sidebarOpen && (
          <div
            className="drag-handle vertical sidebar-handle"
            onMouseDown={(e) => startColumnDrag('left', e)}
          />
        )}

        {researchMode ? (
          <>
            <section className="panel research-workspace-panel" data-testid="research-stage-content">
              <ResearchWorkspacePage embedded onStateChange={handleResearchStateChange} llmConfig={llmConfig} />
            </section>

            <div
              className="drag-handle vertical main-handle"
              onMouseDown={(e) => startColumnDrag('right', e)}
            />

            <section className="panel pdf-panel research-context-panel" data-testid="editor-right-panel">
              <div className="panel-header">
                <div>研究上下文</div>
                <span className={`research-context-stage-status is-${researchWorkspaceState?.stageStatuses[activeResearchStage] || 'active'}`}>
                  {getResearchStage(activeResearchStage).label}
                </span>
              </div>
              <div className="right-body research-context-workspace">
                <div className="research-context-summary">
                  <span className="research-overline">CURRENT INPUT</span>
                  <h3>{researchWorkspaceState?.direction.question || '等待你输入研究问题'}</h3>
                  <p>{researchWorkspaceState?.direction.scope || '研究边界尚未填写'}</p>
                </div>
                <dl className="research-context-details">
                  <dt>种子关键词</dt>
                  <dd>{researchWorkspaceState?.direction.keywords.length ? researchWorkspaceState.direction.keywords.join(' · ') : '尚未填写'}</dd>
                  <dt>论文质量门禁</dt>
                  <dd>
                    {researchWorkspaceState?.policy.venueLevel || 'CCF-A'} · {
                      researchWorkspaceState?.policy.publicationType === 'journal'
                        ? '期刊'
                        : researchWorkspaceState?.policy.publicationType === 'conference'
                          ? '会议'
                          : '期刊/会议'
                    } · {researchWorkspaceState?.policy.yearFrom || '2022'}-{researchWorkspaceState?.policy.yearTo || '2026'}
                  </dd>
                  <dt>当前阶段 Skill</dt>
                  <dd>{researchWorkspaceState?.activeSkillNames.length ? researchWorkspaceState.activeSkillNames.join('、') : '使用阶段默认约束'}</dd>
                  <dt>执行控制</dt>
                  <dd>所有方向、论文、创新点和方法都由你输入或选择，AI 只补充候选并执行已确认任务。</dd>
                </dl>
                <div className="research-context-progress" aria-label="当前阶段">
                  <span>{String(getResearchStage(activeResearchStage).index).padStart(2, '0')}</span>
                  <div>
                    <strong>{getResearchStage(activeResearchStage).label}</strong>
                    <small>{getResearchStage(activeResearchStage).description}</small>
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : (
          <>
        <section className="panel editor-panel">
          <div className="panel-header">{t('Editor')}</div>
          <div className="breadcrumb-bar">
            <span className="breadcrumb-item">{projectName || t('Project')}</span>
            {breadcrumbParts.map((part, idx) => (
              <span key={`${part}-${idx}`} className="breadcrumb-item">{part}</span>
            ))}
            {currentHeading && (
              <span className="breadcrumb-item heading">{currentHeading.title}</span>
            )}
          </div>
          <div className="editor-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertSectionSnippet}>{t('Section')}</button>
              <button className="toolbar-btn" onClick={insertSubsectionSnippet}>{t('Subsection')}</button>
              <button className="toolbar-btn" onClick={insertSubsubsectionSnippet}>{t('Subsubsection')}</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertItemizeSnippet}>{t('Itemize')}</button>
              <button className="toolbar-btn" onClick={insertEnumerateSnippet}>{t('Enumerate')}</button>
              <button className="toolbar-btn" onClick={insertEquationSnippet}>{t('Equation')}</button>
              <button className="toolbar-btn" onClick={insertAlgorithmSnippet}>{t('Algorithm')}</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertFigureTemplate}>{t('Figure')}</button>
              <button className="toolbar-btn" onClick={insertTableSnippet}>{t('Table')}</button>
              <button className="toolbar-btn" onClick={insertListingSnippet}>{t('Listing')}</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertCiteSnippet}>{t('Cite')}</button>
              <button className="toolbar-btn" onClick={insertRefSnippet}>{t('Ref')}</button>
              <button className="toolbar-btn" onClick={insertLabelSnippet}>{t('Label')}</button>
            </div>
            <div className="toolbar-spacer" />
            <div className="toolbar-group font-size-group">
              <button className="toolbar-btn icon-only" onClick={() => setEditorFontSize((s) => Math.max(8, s - 1))} title={t('放大')}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <span className="font-size-label">{editorFontSize}px</span>
              <button className="toolbar-btn icon-only" onClick={() => setEditorFontSize((s) => Math.min(24, s + 1))} title={t('放大')}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
          <div
            className="editor-split"
            ref={editorSplitRef}
          >
            <div className="editor-area" ref={editorAreaRef}>
              <div ref={editorHostRef} className="editor-host" style={{ '--editor-font-size': `${editorFontSize}px` } as React.CSSProperties} />
              <div className="editor-hint muted">{t('快捷键: Option/Alt + / 或 Cmd/Ctrl + Space 补全；Cmd/Ctrl + / 注释；Cmd/Ctrl + F 搜索；Cmd/Ctrl + S 保存')}</div>
              {(inlineSuggestionText || isSuggesting) && suggestionPos && (
                <div
                  className={`suggestion-popover ${isSuggesting && !inlineSuggestionText ? 'loading' : ''}`}
                  style={{ left: suggestionPos.left, top: suggestionPos.top }}
                >
                  {isSuggesting && !inlineSuggestionText ? (
                    <div className="suggestion-loading">
                      <span className="spinner" />
                      {t('AI 补全中...')}
                    </div>
                  ) : (
                    <>
                      <div className="suggestion-preview">{inlineSuggestionText}</div>
                      <div className="row">
                        <button className="btn" onClick={() => acceptSuggestionRef.current()}>{t('接受')}</button>
                        <button className="btn ghost" onClick={() => clearSuggestionRef.current()}>{t('拒绝')}</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          className="drag-handle vertical main-handle"
          onMouseDown={(e) => startColumnDrag('right', e)}
        />

        <section className="panel pdf-panel">
          <div className="panel-header">
            <div>{t('Preview')}</div>
            <div className="header-controls">
              <div className="ios-select-wrapper">
                <button
                  className="ios-select-trigger"
                  onClick={() => setRightViewDropdownOpen(!rightViewDropdownOpen)}
                >
                  <span>{RIGHT_VIEW_OPTIONS(t).find((item) => item.value === rightView)?.label || 'PDF'}</span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={rightViewDropdownOpen ? 'rotate' : ''}>
                    <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                {rightViewDropdownOpen && (
                  <div className="ios-dropdown dropdown-down">
                    {RIGHT_VIEW_OPTIONS(t).map((item) => (
                      <div
                        key={item.value}
                        className={`ios-dropdown-item ${rightView === item.value ? 'active' : ''}`}
                        onClick={() => {
                          setRightView(item.value as 'pdf' | 'figures' | 'diff' | 'log' | 'toc' | 'review');
                          setRightViewDropdownOpen(false);
                        }}
                      >
                        {item.label}
                        {rightView === item.value && (
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="right-body">
            <div className="view-content">
              {(isCompiling || waitingAbandoned) && (
                <div className="compile-input-note" role="status">
                  <div>{isCompiling ? t('退出等待或离开页面不会停止服务端编译。') : t('已退出等待；服务端可能仍在运行，请到任务中心查看或取消。')}</div>
                  <button className="btn ghost small" onClick={() => navigate(`/project/${projectId}/tasks`)}>{t('到任务中心查看或取消')}</button>
                </div>
              )}
              {(rightView === 'pdf' || rightView === 'log') && inputSnapshot && (
                <div className="compile-input-note" role="status">
                  {t('本次编译输入')}：{compiledMainFile} · {inputSnapshot.hash.slice(0, 12)}
                  <div>{t('PDF 和日志对应这次输入；后续编辑需重新编译。')}</div>
                  {(!diagnosticsVerified || (Object.prototype.hasOwnProperty.call(compiledSources, activePath) && compiledSources[activePath] !== editorValue)) && (
                    <div>{t('源码已变化或无法核对，请重新编译后定位错误。')}</div>
                  )}
                </div>
              )}
              {rightView === 'pdf' && (
                <>
                  <div className="pdf-toolbar">
                    <div className="toolbar-group">
                      <button className="icon-btn" onClick={() => zoomPdf(-0.1)} disabled={!pdfUrl}>−</button>
                      <div className="zoom-label">{pdfScaleLabel}</div>
                      <button className="icon-btn" onClick={() => zoomPdf(0.1)} disabled={!pdfUrl}>＋</button>
                      <button className="btn ghost small" onClick={() => setPdfFitWidth(true)} disabled={!pdfUrl}>{t('适合宽度')}</button>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setPdfFitWidth(false);
                          setPdfScale(1);
                        }}
                        disabled={!pdfUrl}
                      >
                        100%
                      </button>
                    </div>
                    <div className="toolbar-group">
                      <button className="btn ghost small" onClick={downloadPdf} disabled={!pdfUrl}>{t('下载 PDF')}</button>
                      <button
                        className={`btn ghost small ${pdfSpread ? 'active' : ''}`}
                        onClick={() => setPdfSpread((prev) => !prev)}
                        disabled={!pdfUrl}
                      >
                        {t('双页')}
                      </button>
                      <button
                        className={`btn ghost small ${pdfAnnotateMode ? 'active' : ''}`}
                        onClick={() => setPdfAnnotateMode((prev) => !prev)}
                        disabled={!pdfUrl}
                      >
                        {t('注释')}
                      </button>
                    </div>
                  </div>
                  {pdfUrl ? (
                    <PdfPreview
                      pdfUrl={pdfUrl}
                      scale={pdfScale}
                      fitWidth={pdfFitWidth}
                      spread={pdfSpread}
                      onFitScale={handleFitScale}
                      onOutline={handlePdfOutline}
                      annotations={pdfAnnotations}
                      annotateMode={pdfAnnotateMode}
                      onAddAnnotation={addPdfAnnotation}
                      containerRef={pdfContainerRef}
                      onTextClick={(text) => {
                        const view = cmViewRef.current;
                        if (!view) return;
                        const docText = view.state.doc.toString();
                        const needle = text.replace(/\s+/g, ' ').trim();
                        if (!needle) return;
                        const idx = docText.indexOf(needle);
                        if (idx >= 0) {
                          view.dispatch({
                            selection: { anchor: idx, head: idx + needle.length },
                            scrollIntoView: true
                          });
                          view.focus();
                        }
                      }}
                    />
                  ) : (
                    <div className="muted pdf-empty-message">{t('尚未生成 PDF')}</div>
                  )}
                  {pdfAnnotations.length > 0 && (
                    <div className="pdf-annotations">
                      <div className="muted">{t('注释')}</div>
                      <div className="annotation-list">
                        {pdfAnnotations.map((note) => (
                          <div key={note.id} className="annotation-item">
                            <button
                              className="annotation-link"
                              onClick={() => scrollToPdfPage(note.page)}
                            >
                              P{note.page}
                            </button>
                            <div className="annotation-text">{note.text}</div>
                            <button
                              className="annotation-remove"
                              onClick={() =>
                                setPdfAnnotations((prev) => prev.filter((item) => item.id !== note.id))
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {rightView === 'toc' && (
                <div className="toc-panel">
                  <div className="toc-title">{t('目录')}</div>
                  {pdfOutline.length === 0 ? (
                    <div className="muted">{t('暂无目录信息。')}</div>
                  ) : (
                    <div className="toc-list">
                      {pdfOutline.map((item, idx) => (
                        <button
                          key={`${item.title}-${idx}`}
                          className={`toc-item level-${item.level}`}
                          onClick={() => {
                            if (item.page) {
                              setRightView('pdf');
                              scrollToPdfPage(item.page);
                            }
                          }}
                        >
                          <span className="toc-title-text">{item.title}</span>
                          {item.page && <span className="toc-page">P{item.page}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {rightView === 'figures' && (
                <div className="figure-panel-v2">
                  <div className="figure-topbar">
                    <div className="ios-select-wrapper" style={{ flex: 1 }}>
                      <button className="ios-select-trigger" onClick={() => setFigureDropdownOpen(!figureDropdownOpen)}>
                        <span>{selectedFigure || t('选择图片进行预览。')}</span>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={figureDropdownOpen ? 'rotate' : ''}>
                          <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      {figureDropdownOpen && (
                        <div className="ios-dropdown dropdown-down">
                          {figureFiles.map((item) => (
                            <div key={item.path} className={`ios-dropdown-item ${selectedFigure === item.path ? 'active' : ''}`} onClick={() => { setSelectedFigure(item.path); setFigureDropdownOpen(false); }}>
                              {item.path}
                              {selectedFigure === item.path && (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {selectedFigure && (
                      <button
                        className="figure-insert-btn"
                        onClick={() => insertFigureSnippet(selectedFigure)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                        {t('插入到光标')}
                      </button>
                    )}
                  </div>
                  <div className="figure-display">
                    {selectedFigure ? (
                      selectedFigure.toLowerCase().endsWith('.pdf') ? (
                        <object data={`/api/projects/${projectId}/blob?path=${encodeURIComponent(selectedFigure)}`} type="application/pdf" />
                      ) : (
                        <img src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(selectedFigure)}`} alt={selectedFigure} />
                      )
                    ) : (
                      <div className="figure-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                        <span>{t('选择图片进行预览。')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {rightView === 'diff' && (
                <div className="diff-panel">
                  <div className="diff-title">{t('Diff Preview ({{count}})', { count: pendingGrouped.length })}</div>
                  {changeReview.error && <div role="alert">{changeReview.error}</div>}
                  {changeReview.busy && <div role="status">{t('正在保存审阅决定…')}</div>}
                  {pendingGrouped.length === 0 && <div className="muted">{t('暂无待确认修改。')}</div>}
                  {pendingGrouped.map((change) => (
                    (() => {
                      const rows = buildSplitDiff(change.original, change.proposed);
                      return (
                        <div key={`${change.runId}:${change.filePath}`} className="diff-item">
                          <div className="diff-header">
                            <div className="diff-path">{change.filePath}</div>
                            <button className="btn ghost" onClick={() => setDiffFocus(change)}>{t('放大')}</button>
                          </div>
                          <SplitDiffView rows={rows} />
                          <div className="row">
                            <button className="btn" disabled={changeReview.busy} onClick={() => applyPending(change)}>{t('应用此修改')}</button>
                            <button className="btn ghost" disabled={changeReview.busy} onClick={() => discardPending(change)}>{t('放弃')}</button>
                          </div>
                        </div>
                      );
                    })()
                  ))}
                  {pendingGrouped.length > 1 && (
                    <div className="row">
                      <button className="btn" disabled={changeReview.busy} onClick={() => applyPending()}>{t('应用全部')}</button>
                      <button className="btn ghost" disabled={changeReview.busy} onClick={() => discardPending()}>{t('全部放弃')}</button>
                    </div>
                  )}
                </div>
              )}
              {rightView === 'log' && (
                <div className="log-panel">
                  <div className="log-title">
                    {t('Compile Log')}
                    <button className="btn ghost log-action" onClick={diagnoseCompile} disabled={diagnoseBusy}>
                      {diagnoseBusy ? (
                        <span className="suggestion-loading">
                          <span className="spinner" />
                          {t('诊断中...')}
                        </span>
                      ) : (
                        t('一键诊断')
                      )}
                    </button>
                  </div>
                  {compileErrors.length > 0 && (
                    <div className="log-errors">
                      {compileErrors.map((error, idx) => {
                        const located = Boolean(error.file && error.line && resolveCompileFile(error.file, tree.filter((item) => item.type === 'file').map((item) => item.path)));
                        return <button
                          key={`${error.message}-${idx}`}
                          className="error-item"
                          onClick={() => jumpToError(error)}
                          disabled={!located}
                        >
                          <span className="error-tag">!</span>
                          <span className="error-text">{error.message}</span>
                          <span className="error-line">{located
                            ? `${error.file}:${error.line}`
                            : t('无法确定项目文件位置，请查看日志')}</span>
                        </button>;
                      })}
                    </div>
                  )}
                  <pre className="log-content">{compileLog || t('暂无编译日志')}</pre>
                </div>
              )}
              {rightView === 'review' && (
                <div className="log-panel">
                  <div className="log-title">{t('评审报告')}</div>
                  <div className="log-content markdown-body">
                    {reviewReport ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{reviewReport}</ReactMarkdown>
                    ) : (
                      t('暂无评审报告')
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
          </>
        )}
      </main>

      {/* Top-bar dropdown portals — rendered outside top-bar to escape backdrop-filter stacking context */}
      {(mainFileDropdownOpen || engineDropdownOpen || langDropdownOpen) && (
        <div className="topbar-dropdown-backdrop" onClick={() => { setMainFileDropdownOpen(false); setEngineDropdownOpen(false); setLangDropdownOpen(false); }} />
      )}
      {mainFileDropdownOpen && topBarDropdownRect && (
        <div className="ios-dropdown dropdown-fixed" style={{ top: topBarDropdownRect.top, left: topBarDropdownRect.left, minWidth: topBarDropdownRect.width }}>
          {(texFiles.length > 0 ? texFiles : ['main.tex']).map((p) => (
            <div key={p} className={`ios-dropdown-item ${mainFile === p ? 'active' : ''}`} onClick={() => { setMainFile(p); setMainFileDropdownOpen(false); }}>
              {p}
              {mainFile === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          ))}
        </div>
      )}
      {engineDropdownOpen && topBarDropdownRect && (
        <div className="ios-dropdown dropdown-fixed" style={{ top: topBarDropdownRect.top, left: topBarDropdownRect.left, minWidth: topBarDropdownRect.width }}>
          {([['pdflatex','pdfLaTeX'],['xelatex','XeLaTeX'],['lualatex','LuaLaTeX'],['latexmk','Latexmk'],['tectonic','Tectonic']] as [string,string][]).map(([val, lbl]) => (
            <div key={val} className={`ios-dropdown-item ${compileEngine === val ? 'active' : ''}`} onClick={() => { setSettings((prev) => ({ ...prev, compileEngine: val as CompileEngine })); setEngineDropdownOpen(false); }}>
              {lbl}
              {compileEngine === val && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          ))}
        </div>
      )}
      {langDropdownOpen && topBarDropdownRect && (
        <div className="ios-dropdown dropdown-fixed" style={{ top: topBarDropdownRect.top, left: topBarDropdownRect.left, minWidth: topBarDropdownRect.width }}>
          {[['zh-CN', t('中文')], ['en-US', t('English')]].map(([val, lbl]) => (
            <div key={val} className={`ios-dropdown-item ${i18n.language === val ? 'active' : ''}`} onClick={() => { i18n.changeLanguage(val); setLangDropdownOpen(false); }}>
              {lbl}
              {i18n.language === val && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          ))}
        </div>
      )}

      {fileContextMenu && (
        <div className="ctx-menu-backdrop" onClick={() => setFileContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFileContextMenu(null); }}>
          <div className="ctx-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onClick={(e) => e.stopPropagation()}>
            <div className="ctx-menu-group">{t('创建')}</div>
            <button className="ctx-menu-item" onClick={() => { beginInlineCreate('new-file'); setFileContextMenu(null); }}>{t('新建文件')}</button>
            <button className="ctx-menu-item" onClick={() => { beginInlineCreate('new-folder'); setFileContextMenu(null); }}>{t('新建文件夹')}</button>
            <button className="ctx-menu-item" onClick={() => { createBibFile(); setFileContextMenu(null); }}>{t('新建 Bib')}</button>
            <div className="ctx-menu-sep" />
            <div className="ctx-menu-group">{t('上传')}</div>
            <button className="ctx-menu-item" onClick={() => { fileInputRef.current?.click(); setFileContextMenu(null); }}>{t('上传文件')}</button>
            <button className="ctx-menu-item" onClick={() => { folderInputRef.current?.click(); setFileContextMenu(null); }}>{t('上传文件夹')}</button>
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item" onClick={() => { setAllFolders(true); setFileContextMenu(null); }}>{t('展开全部')}</button>
            <button className="ctx-menu-item" onClick={() => { setAllFolders(false); setFileContextMenu(null); }}>{t('收起全部')}</button>
            <button className="ctx-menu-item" onClick={() => { beginInlineRename(); setFileContextMenu(null); }}>{t('重命名')}</button>
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item ctx-menu-danger" onClick={() => { handleDeleteFile(); setFileContextMenu(null); }}>{t('删除')}</button>
            <button className="ctx-menu-item" onClick={() => { refreshTree(); setFileContextMenu(null); }}>{t('刷新')}</button>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('Workspace Settings')}</div>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('LLM Endpoint')}</label>
                <input
                  className="input"
                  value={llmEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmEndpoint: e.target.value }))}
                  placeholder="https://api.openai.com/v1/chat/completions"
                />
                <div className="muted">{t('支持 OpenAI 兼容的 base_url，例如 https://api.apiyi.com/v1')}</div>
              </div>
              <div className="field">
                <label>{t('LLM Model')}</label>
                <input
                  className="input"
                  value={llmModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmModel: e.target.value }))}
                  placeholder="gpt-4o-mini"
                />
              </div>
              <div className="field">
                <label>{t('Agent Runtime')}</label>
                <select
                  className="input"
                  value={agentRuntime}
                  onChange={(e) => setSettings((prev) => ({
                    ...prev,
                    agentRuntime: e.target.value === 'deepseek-harness' ? 'deepseek-harness' : 'legacy'
                  }))}
                >
                  <option value="legacy">{t('Legacy LangChain')}</option>
                  <option value="deepseek-harness">{t('DeepSeek Harness')}</option>
                </select>
                <div className="muted">{t('仅影响 Agent 的 Tools 模式；Chat、补全和视觉功能继续使用普通 LLM 调用。')}</div>
              </div>
              <div className="field">
                <label>{t('LLM API Key')}</label>
                <input
                  className="input"
                  value={llmApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
                {!llmApiKey && (
                  <div className="muted">{t('未配置 API Key 时将使用后端环境变量。')}</div>
                )}
              </div>
              <div className="field">
                <label>{t('Search LLM Endpoint (可选)')}</label>
                <input
                  className="input"
                  value={searchEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchEndpoint: e.target.value }))}
                  placeholder="https://api.apiyi.com/v1"
                />
                <div className="muted">{t('仅用于“检索/websearch”任务，留空则复用 LLM Endpoint。')}</div>
              </div>
              <div className="field">
                <label>{t('Search LLM Model (可选)')}</label>
                <input
                  className="input"
                  value={searchModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchModel: e.target.value }))}
                  placeholder="claude-sonnet-4-5-20250929-all"
                />
              </div>
              <div className="field">
                <label>{t('Search LLM API Key (可选)')}</label>
                <input
                  className="input"
                  value={searchApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
              </div>
              <div className="field">
                <label>{t('VLM Endpoint (可选)')}</label>
                <input
                  className="input"
                  value={visionEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionEndpoint: e.target.value }))}
                  placeholder="https://api.apiyi.com/v1"
                />
                <div className="muted">{t('仅用于图像识别，留空则复用 LLM Endpoint。')}</div>
              </div>
              <div className="field">
                <label>{t('VLM Model (可选)')}</label>
                <input
                  className="input"
                  value={visionModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionModel: e.target.value }))}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="field">
                <label>{t('VLM API Key (可选)')}</label>
                <input
                  className="input"
                  value={visionApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setSettingsOpen(false)}>{t('关闭')}</button>
              <button className="btn" onClick={() => setSettingsOpen(false)}>{t('完成')}</button>
            </div>
          </div>
        </div>
      )}
      {diffFocus && (
        <div className="modal-backdrop" onClick={() => setDiffFocus(null)}>
          <div className="modal diff-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('Diff')} · {diffFocus.filePath}</div>
              <button className="icon-btn" onClick={() => setDiffFocus(null)}>✕</button>
            </div>
            <div className="modal-body diff-modal-body">
              <SplitDiffView rows={buildSplitDiff(diffFocus.original, diffFocus.proposed)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
