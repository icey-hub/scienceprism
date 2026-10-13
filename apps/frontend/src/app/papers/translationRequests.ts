import type { ReadingSelection, TranslationConfiguration, TranslationResult, TranslationSettingsPatch } from '../../api/paperReaderAdapter';

export interface ReaderTranslationState {
  configuration: TranslationConfiguration | null;
  loading: boolean; writing: boolean; busy: boolean;
  result: TranslationResult | null; error: string; errorCode: string; notice: string;
}
export const emptyTranslationState: ReaderTranslationState = { configuration: null, loading: false, writing: false, busy: false, result: null, error: '', errorCode: '', notice: '' };
interface TranslationCommands {
  load: (signal: AbortSignal) => Promise<TranslationConfiguration>;
  save: (revision: number, patch: TranslationSettingsPatch, signal: AbortSignal) => Promise<Omit<TranslationConfiguration, 'providers'>>;
  clear: (signal: AbortSignal) => Promise<{ clearedEntries: number; clearedResults: number }>;
  translate: (selection: ReadingSelection, provider: string, target: string, operationId: string, signal: AbortSignal) => Promise<{ translation: TranslationResult }>;
}

// One reader lifetime owns request cancellation and replay identity. Server settings
// stay authoritative; no browser copy or implicit retry creates another operation.
export function createReaderTranslation(commands: TranslationCommands, publish: (state: ReaderTranslationState) => void, makeId = () => crypto.randomUUID()) {
  let state = { ...emptyTranslationState }, active = false;
  let selection: ReadingSelection | null = null;
  let load: AbortController | null = null, write: AbortController | null = null, current: AbortController | null = null;
  let attempt: { key: string; id: string } | null = null;
  const emit = (patch: Partial<ReaderTranslationState>) => { state = { ...state, ...patch }; if (active) publish(state); };
  const fail = (cause: unknown) => {
    let error = cause instanceof Error ? cause.message : String(cause), errorCode = '';
    try { const data = JSON.parse(error); errorCode = data.error?.code || ''; error = data.error?.message || data.message || error; } catch { /* Plain network errors are preserved. */ }
    if (errorCode === 'TRANSLATION_SETTINGS_CONFLICT') error = '设置已在其他窗口修改。请重新读取设置后再保存。';
    if (errorCode === 'TRANSLATION_RESULT_UNAVAILABLE') error = '这个请求已有记录，译文目前不可用，不会自动重复发送。需要再次翻译时，请明确新建请求。';
    emit({ error, errorCode });
  };
  const cancel = () => { current?.abort(); current = null; emit({ busy: false }); };
  const context = (config: TranslationConfiguration | null) => config ? `${config.settings.defaultProviderId}:${config.settings.targetLanguage}` : '';
  const accept = (configuration: TranslationConfiguration) => {
    if (context(configuration) !== context(state.configuration)) { cancel(); emit({ result: null }); }
    emit({ configuration });
  };
  const refresh = async (clearError = false) => {
    if (!active || write) return;
    load?.abort(); const abort = new AbortController(); load = abort;
    emit({ loading: true, ...(clearError ? { error: '', errorCode: '' } : {}) });
    try { const value = await commands.load(abort.signal); if (active && load === abort && !abort.signal.aborted) accept(value); }
    catch (cause) { if (active && load === abort && !abort.signal.aborted) fail(cause); }
    finally { if (load === abort) { load = null; emit({ loading: false }); } }
  };
  const change = async (action: (config: TranslationConfiguration, signal: AbortSignal) => Promise<void>) => {
    if (!active || write || !state.configuration) return;
    load?.abort(); load = null; cancel();
    const abort = new AbortController(); write = abort;
    emit({ writing: true, loading: false, error: '', errorCode: '', notice: '' });
    try { await action(state.configuration, abort.signal); }
    catch (cause) { if (active && !abort.signal.aborted) fail(cause); }
    finally { if (write === abort) { write = null; emit({ writing: false }); } }
  };
  return {
    activate() { active = true; emit({ loading: false, writing: false, busy: false }); },
    dispose() { active = false; load?.abort(); write?.abort(); current?.abort(); load = write = current = null; },
    refresh,
    select(value: ReadingSelection | null) {
      if (selection === value) return;
      selection = value; cancel(); emit({ result: null, error: '', errorCode: '', notice: '' });
    },
    cancel() { cancel(); emit({ notice: '已取消翻译，原文保留；已发送请求的用量可能仍计入预留。' }); void refresh(); },
    save(patch: TranslationSettingsPatch) {
      return change(async (config, signal) => {
        const saved = await commands.save(config.revision, patch, signal);
        if (active && !signal.aborted) { accept({ ...saved, providers: config.providers }); emit({ notice: '已保存到项目，重新打开阅读器仍会使用。' }); }
      });
    },
    clear() {
      return change(async (_config, signal) => {
        const value = await commands.clear(signal);
        if (active && !signal.aborted) emit({ notice: `已清除 ${value.clearedEntries} 条翻译缓存。请求记录保留，原文和批注不受影响。` });
      });
    },
    async translate(newAttempt = false) {
      const config = state.configuration, captured = selection;
      if (!active || current || write || !config || !captured) return;
      const { defaultProviderId: provider, targetLanguage: target } = config.settings;
      const key = JSON.stringify([captured.id, captured.text, captured.attachmentId, captured.fileSha256, captured.page, provider, target]);
      if (!attempt || attempt.key !== key || newAttempt) attempt = { key, id: makeId() };
      const abort = new AbortController(); current = abort;
      emit({ busy: true, result: null, error: '', errorCode: '', notice: '' });
      try {
        const response = await commands.translate(captured, provider, target, attempt.id, abort.signal);
        if (active && current === abort && !abort.signal.aborted && selection === captured && response.translation.selectionId === captured.id && response.translation.providerId === provider && (!response.translation.targetLanguage || response.translation.targetLanguage === target)) emit({ result: response.translation });
      } catch (cause) { if (active && current === abort && !abort.signal.aborted) fail(cause); }
      finally { if (current === abort) { current = null; emit({ busy: false }); if (active) void refresh(); } }
    }
  };
}
