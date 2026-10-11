import { loadSettings } from '../editor/editorSettings';
export function workspaceModel(kind: 'general' | 'search' | 'vision' = 'general') {
  const settings = loadSettings();
  return { endpoint: (kind === 'general' ? '' : settings[`${kind}Endpoint`]) || settings.llmEndpoint,
    apiKey: (kind === 'general' ? '' : settings[`${kind}ApiKey`]) || settings.llmApiKey || undefined,
    model: (kind === 'general' ? '' : settings[`${kind}Model`]) || settings.llmModel,
    runtime: settings.agentRuntime };
}
