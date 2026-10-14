import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, DragEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { searchKeymap } from '@codemirror/search';
import { toggleComment } from '@codemirror/commands';
import { setDiagnostics } from '@codemirror/lint';
import { foldKeymap } from '@codemirror/language';
import { createFolder as createFolderApi, deleteFile, getFile, getProjectTree, listProjects, renamePath, updateFileOrder, uploadFiles, writeFile } from '../api/projectAdapter';
import { getCollabServer, getCollabToken, setCollabServer } from '../api/collaborationAdapter';
import { callLLM, runAgent } from '../api/editorAdapter';
import { createTwoFilesPatch } from 'diff';
import { useCompilation } from './editor/useCompilation';
import { useEditorSession } from './editor/useEditorSession';
import { editorExtensions, setGhostEffect } from './editor/editorExtensions';
import { useCollaborationSession } from './editor/useCollaborationSession';
import { buildSplitDiff, SplitDiffView } from './editor/EditorDiff';
import { PdfPreview } from './editor/PdfPreview';
import { getLatexBodyInsertionRange } from './editor/latexSnippetInsertion';
import { compileDiagnostics, resolveCompileFile, type CompileError } from './editor/compileDiagnostics';
import type { AssistantIntent } from './editor/useAssistantRun';
import { useAssistantRun } from './editor/useAssistantRun';
import { useChangeReview, type PendingChange } from './editor/useChangeReview';
import { useDocumentDrafts } from './editor/useDocumentDrafts';
import { loadCollabName, loadSettings, persistCollabName, persistSettings } from './editor/editorSettings';
import type { AppSettings, CompileEngine } from './editor/editorSettings';
import { ProjectWorkspaceNav } from './components/ProjectWorkspaceNav';
import { rememberEditorFile, restoredEditorFile } from './editor/editorLocation';
import {
  ChevronDown,
  Languages,
  PanelLeft,
  Play,
  Save,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Users,
  X
} from 'lucide-react';

type InlineEdit =
  | { kind: 'new-file' | 'new-folder'; parent: string; value: string }
  | { kind: 'rename'; path: string; value: string };

const RIGHT_VIEW_OPTIONS = (t: (key: string) => string) => [
  { value: 'pdf', label: 'PDF' },
  { value: 'toc', label: t('目录') },
  { value: 'figures', label: 'FIG' },
  { value: 'diff', label: 'DIFF' },
  { value: 'log', label: 'LOG' }
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
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const projectId = routeProjectId || '';
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [projectName, setProjectName] = useState('');
  const [tree, setTree] = useState<{ path: string; type: string }[]>([]);
  const [treeLoaded, setTreeLoaded] = useState(false);
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
  const [rightView, setRightView] = useState<'pdf' | 'figures' | 'diff' | 'log' | 'toc'>('pdf');
  const [selectedFigure, setSelectedFigure] = useState<string>('');
  const [diffFocus, setDiffFocus] = useState<PendingChange | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const [outlineText, setOutlineText] = useState('');
  const [currentHeading, setCurrentHeading] = useState<{ title: string; level: string } | null>(null);
  const diagnoseBusy = assistant.busy;
  const [collabEnabled, setCollabEnabled] = useState(() => Boolean(getCollabToken()) || searchParams.get('collab') === 'on');
  const [collabServer] = useState(() => getCollabServer() || (typeof window === 'undefined' ? '' : window.location.origin));
  const [collabName] = useState(() => loadCollabName() || 'Guest');
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
  const {
    llmEndpoint,
    llmApiKey,
    llmModel,
    agentRuntime,
    compileEngine
  } = settings;

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

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

  const refreshTree = async (keepActive = true) => {
    if (!projectId) return;
    const res = await getProjectTree(projectId);
    const visibleItems = res.items.filter((item) => !isInternalProjectPath(item.path));
    setTree(visibleItems);
    setTreeLoaded(true);
    setFileOrder(res.fileOrder || {});
    if (!keepActive || !activePath || !visibleItems.find((item) => item.path === activePath)) {
      const requested = searchParams.get('file') || searchParams.get('open');
      const filePaths = visibleItems.filter((item) => item.type === 'file').map((item) => item.path);
      const requestedPath = requested && filePaths.includes(requested) ? requested : '';
      // The source-link effect opens explicit targets and positions the cursor together.
      if (requestedPath && !treeLoaded) return;
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

  const { activeRef: collabActiveRef, status: collabStatus,
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

  const sourcePath = searchParams.get('file') || searchParams.get('open') || '';
  const sourceLine = searchParams.get('line') || '';
  const sourceNavigationRef = useRef({ openFile, tree, collabEnabled });
  sourceNavigationRef.current = { openFile, tree, collabEnabled };
  useEffect(() => {
    if (!treeLoaded || !sourcePath) return;
    const current = sourceNavigationRef.current;
    if (!current.tree.some(item => item.type === 'file' && item.path === sourcePath)) {
      setStatus(t('来源文件不存在或不可访问：{{path}}', { path: sourcePath }));
      return;
    }
    let cancelled = false;
    const request = openFileSequenceRef.current + 1;
    current.openFile(sourcePath).then(() => {
      if (cancelled || request !== openFileSequenceRef.current || activePathRef.current !== sourcePath) return;
      if (!sourceLine) return;
      const line = Number(sourceLine);
      const view = cmViewRef.current;
      if (!/^\d+$/.test(sourceLine) || !Number.isSafeInteger(line) || line < 1) {
        setStatus(t('来源行号无效。'));
      } else if (current.collabEnabled && isTextPath(sourcePath)) {
        setStatus(t('已打开来源文件；协同编辑中的行号可能变化，请按引用键查找。'));
      } else if (!view || line > view.state.doc.lines) {
        setStatus(t('来源行号已超出当前文稿，请刷新写作检查。'));
      } else {
        const target = view.state.doc.line(line);
        view.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
        view.focus();
      }
    }).catch(error => {
      if (!cancelled && request === openFileSequenceRef.current) setStatus(t('打开来源失败：{{error}}', { error: String(error) }));
    });
    return () => { cancelled = true; ++openFileSequenceRef.current; };
  }, [sourcePath, sourceLine, treeLoaded, t]);

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

  const handleUpload = async (fileList: FileList | null, basePath = '') => {
    if (!projectId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    await uploadFiles(projectId, files, basePath);
    await refreshTree();
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
    if (texFiles.length === 0) return;
    if (!texFiles.includes(mainFile)) {
      const preferred = texFiles.find((path) => path.endsWith('main.tex')) || texFiles[0];
      setMainFile(preferred);
    }
  }, [texFiles, mainFile]);

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
    return accepted;
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
    <div className="app-shell workspace-shell is-writing">
      <ProjectWorkspaceNav projectId={projectId} projectName={projectName} active="writing" />
      <header className="top-bar">
        <div className="editor-titlebar">
          <button className="icon-btn" onClick={() => setSidebarOpen((prev) => !prev)} title={sidebarOpen ? t('关闭项目文件') : t('打开项目文件')} aria-label={sidebarOpen ? t('关闭项目文件') : t('打开项目文件')}>
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
          <button className={`icon-btn${collabEnabled ? ' active' : ''}`} aria-label={collabEnabled ? '断开协作' : '开启协作'} title={collabEnabled ? `协作：${collabStatus}` : '开启协作'} onClick={() => setCollabEnabled(value => !value)}><Users size={17}/></button>
          <button className="icon-btn" onClick={() => navigate(`/project/${projectId}/models`)} title={t('设置')} aria-label={t('设置')}><SettingsIcon size={17} /></button>
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
      </header>

      <div className="status-bar">
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
      </div>


      <main
        className="workspace"
        ref={gridRef}
        style={{
          '--col-sidebar': sidebarOpen ? `${columnSizes.sidebar}px` : '0px',
          '--col-sidebar-gap': sidebarOpen ? '10px' : '0px',
          '--col-editor': `${columnSizes.editor}px`,
          '--col-right': `${columnSizes.right}px`
        } as CSSProperties}
      >
        {sidebarOpen && (
          <aside className="panel side-panel">
            <div className="panel-header"><span>项目文件</span><button className="icon-btn" onClick={() => setSidebarOpen(false)} aria-label="关闭项目文件"><X size={15}/></button></div>
            {(
              <>
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
            )}
          </aside>
        )}

        {sidebarOpen && (
          <div
            className="drag-handle vertical sidebar-handle"
            onMouseDown={(e) => startColumnDrag('left', e)}
          />
        )}

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
                          setRightView(item.value as 'pdf' | 'figures' | 'diff' | 'log' | 'toc');
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
            </div>
          </div>
        </section>
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
            <button className="ctx-menu-item" onClick={() => { beginInlineCreate('new-file'); setInlineEdit(previous => previous ? { ...previous, value: 'references.bib' } : previous); setFileContextMenu(null); }}>{t('新建 Bib')}</button>
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
