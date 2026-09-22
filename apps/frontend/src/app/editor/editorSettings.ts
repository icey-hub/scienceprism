import {
  COLLAB_STORAGE_KEY,
  migrateCollabName,
  migrateSettingsRecord,
  SETTINGS_STORAGE_KEY
} from './settingsMigration.js';

export type CompileEngine = 'pdflatex' | 'xelatex' | 'lualatex' | 'latexmk' | 'tectonic';

export type AppSettings = {
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  agentRuntime: 'legacy' | 'deepseek-harness';
  searchEndpoint: string;
  searchApiKey: string;
  searchModel: string;
  visionEndpoint: string;
  visionApiKey: string;
  visionModel: string;
  compileEngine: CompileEngine;
};

const SETTINGS_KEY = SETTINGS_STORAGE_KEY;
const COLLAB_NAME_KEY = COLLAB_STORAGE_KEY;
const COLLAB_COLORS = ['#b44a2f', '#2f6fb4', '#2f9b74', '#b48a2f', '#6b2fb4', '#b42f6d', '#2f8fb4'];

const DEFAULT_SETTINGS: AppSettings = {
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  agentRuntime: 'legacy',
  searchEndpoint: '',
  searchApiKey: '',
  searchModel: '',
  visionEndpoint: '',
  visionApiKey: '',
  visionModel: '',
  compileEngine: 'pdflatex'
};

export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const { settings: stored } = migrateSettingsRecord(window.localStorage, DEFAULT_SETTINGS);
    const parsed = stored as Partial<AppSettings>;
    const validEngines: CompileEngine[] = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];
    const compileEngine = validEngines.includes(parsed.compileEngine as CompileEngine) ? parsed.compileEngine as CompileEngine : DEFAULT_SETTINGS.compileEngine;
    return { ...DEFAULT_SETTINGS, ...parsed, agentRuntime: parsed.agentRuntime === 'deepseek-harness' ? 'deepseek-harness' : 'legacy', compileEngine };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function persistSettings(settings: AppSettings) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* local storage can be unavailable */ }
}

export function loadCollabName() {
  if (typeof window === 'undefined') return '';
  try { return migrateCollabName(window.localStorage); } catch { return ''; }
}

export function persistCollabName(name: string) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(COLLAB_NAME_KEY, name); } catch { /* local storage can be unavailable */ }
}

export function pickCollabColor(seed?: string) {
  if (!seed) return COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return COLLAB_COLORS[hash % COLLAB_COLORS.length];
}

export function normalizeServerUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
