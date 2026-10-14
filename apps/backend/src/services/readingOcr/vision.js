import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const source = fileURLToPath(new URL('./worker.swift', import.meta.url));
const repo = path.resolve(path.dirname(source), '../../../../..');
const cache = path.join(repo, '.cache/reading-ocr');
const compiler = '/usr/bin/swiftc';
const sdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, statusCode = 422) => Object.assign(new Error(message), { code, statusCode });
let preparing;
async function stopped(pid) { if (!pid) return; try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; } throw failure('OCR_STOP_UNCONFIRMED', '本地OCR进程尚未确认停止。', 503); }
async function execute(executable, args, { input, signal, onProcess, timeoutMs = 30000, maxBytes = 1024 * 1024, env } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, cwd: cache, env: env || { PATH: '/usr/bin:/bin', TMPDIR: cache }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = [], stderr = [], size = 0, error, timer, killTimer, recorded = Promise.resolve();
    const stop = reason => { error ||= reason; child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 500); };
    const abort = () => stop(failure('OCR_CANCELLED', '本地OCR已取消。', 499));
    const collect = list => chunk => { size += chunk.length; if (size > maxBytes) stop(failure('OCR_OUTPUT_LIMIT', '本地OCR输出超过上限。')); else list.push(chunk); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', problem => { error ||= problem; });
    child.once('spawn', () => { recorded = Promise.resolve().then(() => onProcess?.({ pid: child.pid, stopConfirmed: false })); recorded.catch(stop); });
    child.once('close', async code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      try {
        await recorded; await stopped(child.pid); await onProcess?.({ pid: child.pid || null, stopConfirmed: true });
        if (error) throw error;
        const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8');
        if (code !== 0) { let known; try { known = JSON.parse(out).error; } catch {} throw failure(known?.code || 'OCR_PROCESS_FAILED', known?.message || err.slice(0, 2000) || `本地OCR退出：${code}`); }
        resolve(out);
      } catch (problem) { reject(problem); }
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    timer = setTimeout(() => stop(failure('OCR_TIMEOUT', '本地OCR超过固定超时上限。', 504)), timeoutMs);
    child.stdin.on('error', problem => { if (problem.code !== 'EPIPE') stop(problem); }); child.stdin.end(input || '');
  });
}
async function prepare() {
  if (process.platform !== 'darwin') throw failure('OCR_UNAVAILABLE', '当前仅配置macOS Apple Vision本地OCR。', 503);
  if (preparing) return preparing;
  preparing = (async () => {
    await fs.mkdir(cache, { recursive: true });
    const bytes = await fs.readFile(source), sha = digest(bytes), version = `apple-vision-v1-${sha.slice(0, 12)}`;
    const binary = path.join(cache, `worker-${sha}`);
    try { const stat = await fs.lstat(binary); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('OCR_BINARY_INVALID', '固定OCR缓存不可用。', 503); await fs.access(binary, constants.X_OK); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = `${binary}.${process.pid}.tmp`;
      try {
        await execute(compiler, ['-O', '-sdk', sdk, '-module-cache-path', path.join(cache, 'modules'), source, '-o', temporary], { timeoutMs: 90000, env: { PATH: '/usr/bin:/bin', TMPDIR: cache } });
        if (digest(await fs.readFile(source)) !== sha) throw failure('OCR_SOURCE_CHANGED', '固定OCR源码在编译期间变化。', 503);
        await fs.rename(temporary, binary);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    return { binary, version, sha };
  })();
  try { return await preparing; } catch (error) { preparing = null; throw error; }
}
function validate(input) {
  if (!input || typeof input.pdfPath !== 'string' || !path.isAbsolute(input.pdfPath) || !/\.pdf$/i.test(input.pdfPath) || /[\x00-\x1f]/.test(input.pdfPath)
    || !Number.isInteger(input.page) || input.page < 1 || input.page > 10000 || ![0, 90, 180, 270].includes(input.rotation)
    || typeof input.language !== 'string' || !/^[A-Za-z][A-Za-z-]{0,31}$/.test(input.language)) throw failure('OCR_INPUT_INVALID', '请选择真实PDF、页码、固定旋转角和有效语言。', 400);
  const r = input.region;
  if (!r || Object.keys(r).some(k => !['x', 'y', 'width', 'height'].includes(k)) || !['x', 'y', 'width', 'height'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]))
    || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) throw failure('OCR_INPUT_INVALID', '区域需在未旋转PDF可见页框（CropBox∩MediaBox）内，使用左上归一化坐标。', 400);
}
export async function capabilities() {
  try {
    const prepared = await prepare(), actual = JSON.parse(await execute(prepared.binary, ['capabilities']));
    return { available: true, engine: 'apple-vision', version: `${prepared.version}-revision${actual.revision}`, languages: actual.languages };
  } catch (error) { return { available: false, engine: 'apple-vision', version: 'apple-vision-v1', languages: [], reason: error.message }; }
}
export async function recognize(input) {
  validate(input); input.signal?.throwIfAborted();
  const stat = await fs.lstat(input.pdfPath), real = await fs.realpath(input.pdfPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 32 * 1024 * 1024 || real !== input.pdfPath) throw failure('OCR_PDF_INVALID', 'OCR输入须为真实绝对路径下≤32MiB的普通PDF。', 400);
  const prepared = await prepare(); input.signal?.throwIfAborted();
  const request = { pdfPath: real, page: input.page, region: input.region, rotation: input.rotation, language: input.language };
  const result = JSON.parse(await execute('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', prepared.binary, 'recognize'], { input: JSON.stringify(request), signal: input.signal, onProcess: input.onProcess }));
  const after = await fs.lstat(real);
  if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw failure('OCR_SOURCE_CHANGED', 'PDF在识别期间变化，请重新选择来源。', 409);
  if (digest(await fs.readFile(source)) !== prepared.sha) throw failure('OCR_SOURCE_CHANGED', '固定OCR源码发生变化，不发布旧worker结果。', 503);
  if (typeof result.text !== 'string' || !Array.isArray(result.lines) || result.lines.length > 2000 || result.basis !== 'crop-image-top-left-normalized'
    || result.lines.some(l => typeof l.text !== 'string' || !Number.isFinite(l.confidence) || l.confidence < 0 || l.confidence > 1 || !l.rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(l.rect[k])))) throw failure('OCR_OUTPUT_INVALID', '固定OCR返回格式无效。');
  return { ...result, version: `${prepared.version}-revision${result.revision}` };
}
