import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { compileProject } from '../../api/editorAdapter';
import { getAllFiles } from '../../api/projectAdapter';
import type { CompileEngine } from './editorSettings';
import { matchesCompileInput, parseCompileErrors } from './compileDiagnostics';
import type { CompileInputSnapshot } from '../../api/client';

type CompileRequest = {
  mainFile: string;
  engine: CompileEngine;
  activePath: string;
  editorValue: string;
  save: () => Promise<unknown>;
  onStatus: (message: string) => void;
  onView: (view: 'pdf' | 'log') => void;
};

/** Own compilation results and their browser resources for one project session. */
export function useCompilation(projectId: string) {
  const { t } = useTranslation();
  const [compileLog, setCompileLog] = useState('');
  const [compiledSources, setCompiledSources] = useState<Record<string, string>>({});
  const [compiledMainFile, setCompiledMainFile] = useState('main.tex');
  const [pdfUrl, setPdfUrl] = useState('');
  const [engineName, setEngineName] = useState('');
  const [inputSnapshot, setInputSnapshot] = useState<CompileInputSnapshot>();
  const [diagnosticsVerified, setDiagnosticsVerified] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const session = useRef(0);
  const owner = useRef(projectId);
  owner.current = projectId;
  const running = useRef(false);
  const resource = useRef('');
  const requestController = useRef<AbortController>();
  const [waitingAbandoned, setWaitingAbandoned] = useState(false);

  const abandonWait = () => {
    if (!running.current) return;
    session.current += 1;
    requestController.current?.abort();
    requestController.current = undefined;
    running.current = false;
    setIsCompiling(false);
    setWaitingAbandoned(true);
    setCompileLog(t('已退出等待；服务端可能仍在运行，请到任务中心查看或取消。'));
  };

  useEffect(() => {
    session.current += 1;
    running.current = false;
    setCompileLog('');
    setCompiledSources({});
    setCompiledMainFile('main.tex');
    setPdfUrl('');
    setEngineName('');
    setInputSnapshot(undefined);
    setDiagnosticsVerified(false);
    setIsCompiling(false);
    setWaitingAbandoned(false);
    return () => {
      session.current += 1;
      requestController.current?.abort();
      requestController.current = undefined;
      if (resource.current) URL.revokeObjectURL(resource.current);
      resource.current = '';
    };
  }, [projectId]);

  const compile = async ({ mainFile, engine, activePath, editorValue, save, onStatus, onView }: CompileRequest) => {
    if (!projectId || running.current) return;
    running.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    setWaitingAbandoned(false);
    const generation = session.current;
    const current = () => generation === session.current && owner.current === projectId;
    setIsCompiling(true);
    onStatus(t('编译中...'));
    setCompileLog('');
    setCompiledSources({});
    setCompiledMainFile(mainFile);
    setInputSnapshot(undefined);
    setDiagnosticsVerified(false);
    if (resource.current) URL.revokeObjectURL(resource.current);
    resource.current = '';
    setPdfUrl('');
    setEngineName('');
    let inputNote = '';
    try {
      await save();
      if (!current()) return;
      const { files } = await getAllFiles(projectId);
      if (!current()) return;
      const sources = Object.fromEntries(files.filter((file) => file.encoding !== 'base64').map((file) => [file.path, file.content]));
      const main = files.find((file) => file.path === mainFile);
      const hasMain = activePath === mainFile ? Boolean(editorValue) : Boolean(main && (main.encoding === 'base64' || main.content));
      if (!hasMain) throw new Error(t('主文件不存在: {{file}}', { file: mainFile }));
      const result = await compileProject({ projectId, mainFile, engine }, controller.signal);
      if (!current()) return;
      if (result.cancelled && result.code === 'COMPILE_CANCELLED') {
        setCompileLog([t('服务端编译已取消。'), result.log].filter(Boolean).join('\n'));
        onView('log');
        onStatus(t('服务端编译已取消。'));
        return;
      }
      const snapshot = result.inputSnapshot;
      const verified: Record<string, string> = {};
      for (const [file, source] of Object.entries(sources)) {
        if (await matchesCompileInput(snapshot, file, source)) verified[file] = source;
        if (!current()) return;
      }
      setInputSnapshot(snapshot);
      setCompiledSources(verified);
      setCompiledMainFile(snapshot?.mainFile || mainFile);
      const textInputs = snapshot?.files.filter((file) => /\.(tex|bib|sty|cls)$/i.test(file.path)) || [];
      const verifiedAll = Boolean(snapshot && textInputs.length && textInputs.every((file) => Object.prototype.hasOwnProperty.call(verified, file.path)));
      setDiagnosticsVerified(verifiedAll);
      inputNote = snapshot ? t('编译输入：{{hash}}', { hash: snapshot.hash }) : t('未收到编译输入版本，请重新编译。');
      if (!verifiedAll) inputNote += `\n${t('部分源码与编译输入不一致或无法核对；这些文件的错误行号不可定位，请重新编译。')}`;
      if (!result.ok || !result.pdf) throw new Error([result.error, result.log].filter(Boolean).join('\n') || t('后端编译失败'));
      const bytes = Uint8Array.from(atob(result.pdf), (char) => char.charCodeAt(0));
      const nextUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (resource.current) URL.revokeObjectURL(resource.current);
      resource.current = nextUrl;
      setPdfUrl(nextUrl);
      setEngineName(engine);
      setCompileLog(`${t('Engine: {{engine}}', { engine })}\n${t('Main file: {{file}}', { file: mainFile })}\n${inputNote}\n\n${result.log || t('No log')}`.trim());
      onView('pdf');
      onStatus(t('编译完成 ({{engine}})', { engine }));
    } catch (error) {
      if (!current()) return;
      console.error('Compilation error:', error);
      const detail = String(error);
      setCompileLog(`${t('编译错误: {{error}}', { error: detail })}${inputNote ? `\n${inputNote}` : ''}`);
      onView('log');
      onStatus(t('编译失败: {{error}}', { error: detail.split('\n')[0] }));
    } finally {
      if (current()) {
        requestController.current = undefined;
        running.current = false;
        setIsCompiling(false);
      }
    }
  };

  const compileErrors = useMemo(() => parseCompileErrors(compileLog, compiledMainFile), [compileLog, compiledMainFile]);
  return { compile, abandonWait, waitingAbandoned, compileLog, compiledSources, compiledMainFile, inputSnapshot, diagnosticsVerified, pdfUrl, engineName, isCompiling, compileErrors };
}
