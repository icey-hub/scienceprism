import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { ensureDir } from '../utils/fsUtils.js';
import { getProjectRoot } from './projectService.js';
import { safeJoin } from '../utils/pathUtils.js';
import { copyCompileInputs } from './compileSnapshot.js';

const SUPPORTED_ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];
const MULTI_PASS_ENGINES = ['pdflatex', 'xelatex', 'lualatex'];

function buildCommand(engine, outDir, mainFile) {
  switch (engine) {
    case 'pdflatex':
    case 'xelatex':
    case 'lualatex':
      return { cmd: engine, args: ['-interaction=nonstopmode', '-file-line-error', `-output-directory=${outDir}`, mainFile] };
    case 'latexmk': return { cmd: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', '-file-line-error', `-outdir=${outDir}`, mainFile] };
    case 'tectonic': return { cmd: 'tectonic', args: ['--print', '--outdir', outDir, mainFile] };
    default: return null;
  }
}
export { SUPPORTED_ENGINES };

function runSpawn(cmd, args, cwd, pushLog, env, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(cmd, args, { cwd, env: env || process.env, detached: grouped });
    let spawnError;
    let closed;
    let stopping = false;
    let escalated = false;
    const settle = () => {
      if (!closed || (stopping && !escalated)) return;
      signal?.removeEventListener('abort', stop);
      if (spawnError) reject(spawnError);
      else resolve(closed);
    };
    const kill = terminationSignal => {
      if (!child.pid) return;
      try {
        // POSIX group includes latexmk/bibliography children; Windows kills only the child.
        if (grouped) process.kill(-child.pid, terminationSignal);
        else if (!closed) child.kill(terminationSignal);
      } catch (error) { if (error.code !== 'ESRCH') spawnError = error; }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill('SIGTERM');
      // Even if the leader exits early, terminate remaining group members before cleanup.
      setTimeout(() => { kill('SIGKILL'); escalated = true; settle(); }, 500);
    };
    child.stdout.on('data', chunk => pushLog(chunk, 'stdout'));
    child.stderr.on('data', chunk => pushLog(chunk, 'stderr'));
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, terminationSignal) => { closed = { code, signal: terminationSignal }; settle(); });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export async function runCompile({ projectId, mainFile, engine = 'pdflatex', signal }) {
  if (!SUPPORTED_ENGINES.includes(engine)) return { ok: false, error: `Unsupported engine: ${engine}` };
  const projectRoot = await getProjectRoot(projectId);
  const buildRoot = safeJoin(projectRoot, '.compile');
  const runId = crypto.randomUUID();
  const runRoot = path.join(buildRoot, runId);
  const inputRoot = path.join(runRoot, 'input');
  const outDir = path.join(runRoot, 'output');
  await ensureDir(buildRoot);
  let inputSnapshot;
  const logChunks = [];
  try {
    signal?.throwIfAborted();
    inputSnapshot = await copyCompileInputs(projectRoot, inputRoot, { runId, mainFile, engine });
    await ensureDir(outDir);
    const MAX_LOG_BYTES = 200_000;
    const ignoredBibError = 'errors were issued by BibTeX, but were ignored';
    const tails = { stdout: '', stderr: '' };
    let bibliographyFailed = false;
    const pushLog = (chunk, stream = 'stdout') => {
      const text = chunk.toString();
      if (engine === 'tectonic') {
        // Scan each stream independently, including output beyond the display limit.
        const diagnostic = tails[stream] + text;
        if (diagnostic.includes(ignoredBibError)) bibliographyFailed = true;
        tails[stream] = diagnostic.slice(-(ignoredBibError.length - 1));
      }
      const current = logChunks.reduce((sum, item) => sum + item.length, 0);
      if (current < MAX_LOG_BYTES) logChunks.push(text.slice(0, MAX_LOG_BYTES - current));
    };
    const command = buildCommand(engine, outDir, mainFile);
    const run = async (cmd, args, cwd = inputRoot, env) => {
      const result = await runSpawn(cmd, args, cwd, pushLog, env, signal);
      signal?.throwIfAborted();
      return result;
    };
    const first = await run(command.cmd, command.args);
    let final = first;
    if (first.code === 0 && MULTI_PASS_ENGINES.includes(engine)) {
      const base = path.basename(mainFile, path.extname(mainFile));
      const auxPath = path.join(outDir, `${base}.aux`);
      let useBiber = false;
      try { useBiber = (await fs.readFile(auxPath, 'utf8')).includes('\\abx@aux@'); } catch {}
      if (!useBiber) { try { useBiber = /\\usepackage(\[.*?\])?\{biblatex\}/.test(await fs.readFile(path.join(inputRoot, mainFile), 'utf8')); } catch {} }
      const bibCmd = useBiber ? 'biber' : 'bibtex';
      const bibEnv = { ...process.env, BIBINPUTS: `${inputRoot}:`, BSTINPUTS: `${inputRoot}:` };
      const bibArgs = useBiber ? [`--input-directory=${inputRoot}`, base] : [base];
      try {
        const bib = await run(bibCmd, bibArgs, outDir, bibEnv);
        if (bib.code !== 0) pushLog(Buffer.from(`[warn] ${bibCmd} exited with status ${bib.code}.\n`));
      } catch (error) {
        signal?.throwIfAborted();
        pushLog(Buffer.from(`[warn] ${bibCmd} not available, skipping bibliography pass: ${error.message}\n`));
      }
      final = await run(command.cmd, command.args);
      if (final.code === 0) final = await run(command.cmd, command.args);
    }
    const base = path.basename(mainFile, path.extname(mainFile));
    const pdfPath = path.join(outDir, `${base}.pdf`);
    const pdfBase64 = final.code === 0 && !bibliographyFailed ? (await fs.readFile(pdfPath).then(buffer => buffer.toString('base64')).catch(() => '')) : '';
    signal?.throwIfAborted();
    const log = logChunks.join('');
    if (bibliographyFailed) return { ok: false, error: 'Tectonic reported bibliography errors. Review the log and repair the bibliography before recompiling.', log, status: final.code ?? -1, inputSnapshot };
    if (final.code !== 0 || final.signal || !pdfBase64) return { ok: false, error: final.code !== 0 ? 'Compilation failed.' : 'No PDF generated.', log, status: final.code ?? -1, inputSnapshot };
    return { ok: true, pdf: pdfBase64, log, status: 0, inputSnapshot };
  } catch (error) {
    if (signal?.aborted) return { ok: false, cancelled: true, code: 'COMPILE_CANCELLED', error: 'Compilation cancelled.', log: logChunks.join(''), inputSnapshot };
    if (!inputSnapshot) throw error;
    return { ok: false, error: `${engine} could not complete: ${error.message}`, log: logChunks.join(''), inputSnapshot };
  } finally {
    // runRoot is our UUID child of the verified project build directory.
    if (path.dirname(path.resolve(runRoot)) !== path.resolve(buildRoot)) throw new Error('Invalid compile cleanup path.');
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}
