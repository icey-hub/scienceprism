import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isOsSandboxApplicable } from './adapters.js';
import { ExperimentRunnerError } from './errors.js';

const sandboxExecutable = '/usr/bin/sandbox-exec';
const metadataScript = `import sys,platform,json,importlib.metadata,hashlib,os
p=[]
for d in importlib.metadata.distributions():
 m=d.read_text('METADATA') or ''; r=d.read_text('RECORD') or ''
 p.append({'name':d.metadata['Name'],'version':d.version,'metadataSha256':hashlib.sha256((m+'\\0'+r).encode()).hexdigest()})
p.sort(key=lambda d:(d['name'].lower(),d['version'],d['metadataSha256']))
print(json.dumps({'python':{'executable':sys.executable,'version':platform.python_version(),'prefix':sys.prefix,'basePrefix':sys.base_prefix,'implementation':platform.python_implementation()},'packages':p,'hardware':{'platform':sys.platform,'arch':platform.machine(),'cpuCount':os.cpu_count()},'installedMetadataSha256':hashlib.sha256(json.dumps(p,sort_keys=True,separators=(',',':')).encode()).hexdigest()}))`;
const wheelArchiveScript = `import sys,zipfile,stat,hashlib,json,unicodedata
total=0; count=0
try:
 for index in range(1,len(sys.argv),2):
  with open(sys.argv[index],'rb') as source:
   digest=hashlib.file_digest(source,'sha256').hexdigest()
   if digest!=sys.argv[index+1]: raise ValueError('changed')
   source.seek(0)
   with zipfile.ZipFile(source) as archive:
    seen=set()
    for item in archive.infolist():
     count+=1; total+=item.file_size
     name=item.filename; parts=name.rstrip('/').split('/'); kind=stat.S_IFMT(item.external_attr>>16)
     key=unicodedata.normalize('NFC',name).casefold()
     if count>30000 or total>128*1024*1024 or item.file_size>32*1024*1024: raise ValueError('budget')
     if name!=item.orig_filename or not name or name.startswith('/') or '\\\\' in name or any(ord(c)<32 or ord(c)==127 for c in name) or any(not p or p in ('.','..') or ':' in p or p.rstrip(' .')!=p for p in parts): raise ValueError('path')
     if key in seen: raise ValueError('duplicate')
     seen.add(key)
     if kind not in ((0,stat.S_IFDIR) if item.is_dir() else (0,stat.S_IFREG)) or item.flag_bits&1 or item.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED): raise ValueError('type')
 print(json.dumps({'valid':True,'uncompressedBytes':total,'entryCount':count}))
except (OSError,ValueError,zipfile.BadZipFile,NotImplementedError):
 print(json.dumps({'valid':False}))`;

function failure(code, message, status = 400) { return new ExperimentRunnerError(status, code, message); }
function cancelled(signal) {
  if (signal?.aborted) throw failure('PYTHON_ENVIRONMENT_CANCELLED', 'Python environment preparation was cancelled.', 409);
}

async function configuredInterpreter() {
  const configured = process.env.SCIENCEPRISM_EXPERIMENT_PYTHON;
  if (!configured || !path.isAbsolute(configured)) throw failure('PYTHON_RUNTIME_UNAVAILABLE', 'Configure an absolute trusted SCIENCEPRISM_EXPERIMENT_PYTHON interpreter.', 503);
  const realPath = await fs.realpath(configured).catch(() => null);
  if (!realPath || !(await fs.stat(realPath)).isFile()) throw failure('PYTHON_RUNTIME_UNAVAILABLE', 'The configured trusted Python interpreter is unavailable.', 503);
  await fs.access(realPath, fs.constants.X_OK).catch(() => { throw failure('PYTHON_RUNTIME_UNAVAILABLE', 'The configured Python interpreter is not executable.', 503); });
  return { configured, realPath };
}

function filters(paths) {
  const result = new Set();
  for (const allowedPath of paths) {
    let current = path.resolve(allowedPath);
    result.add(`(literal ${JSON.stringify(current)})`);
    result.add(`(subpath ${JSON.stringify(current)})`);
    while (current !== path.dirname(current)) {
      current = path.dirname(current);
      result.add(`(literal ${JSON.stringify(current)})`);
    }
  }
  return [...result].join(' ');
}

// The same OS boundary as Experiment Runner: explicit runtime/inputs readable,
// only the environment writable, and no network. Python has no Node fallback.
export function pythonEnvironmentSandboxProfile({ directory, runtimePaths = [], wheelPaths = [], writable = true }) {
  const readable = [directory, ...runtimePaths, ...wheelPaths, '/System/Library', '/usr/lib', '/usr/share/locale', '/private/var/db/timezone', '/etc/localtime', '/dev/null', '/dev/random', '/dev/urandom'].filter(Boolean);
  return ['(version 1)', '(allow default)', '(deny network*)',
    `(deny file-read* (require-not (require-any ${filters(readable)})))`,
    writable ? `(deny file-write* (require-not (subpath ${JSON.stringify(directory)})))` : '(deny file-write*)'].join('\n');
}

function safeEnvironment(directory) {
  return {
    PATH: '/usr/bin:/bin', HOME: directory ? path.join(directory, '.python-home') : '/dev/null',
    TMPDIR: directory ? path.join(directory, '.python-tmp') : '/dev/null',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_CONFIG_FILE: '/dev/null',
    PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    ...(directory ? { XDG_CACHE_HOME: path.join(directory, '.python-home') } : {})
  };
}

async function runPython({ executable, args, directory, profile, signal, beforeLaunch, onLaunch, onProcess, onOutput, timeoutMs, maxOutputBytes }) {
  cancelled(signal);
  await beforeLaunch?.();
  cancelled(signal);
  await onLaunch?.();
  // A callback may cancel while the durable launch intent is being saved. No
  // process exists in that case, so the owner can safely clear the intent.
  if (signal?.aborted) {
    await onProcess?.({ pid: null, stopConfirmed: true });
    cancelled(signal);
  }
  let child;
  try {
    child = spawn(sandboxExecutable, ['-p', profile, executable, ...args], {
      cwd: directory || '/', env: safeEnvironment(directory), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    await onProcess?.({ pid: null, stopConfirmed: true });
    throw error;
  }
  let stdout = ''; let stderr = ''; let bytes = 0; let error; let killTimer;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, closeSignal) => resolve({ exitCode, signal: closeSignal }));
  });
  closed.catch(() => {});
  const kill = (kind) => { try { if (child.pid) process.kill(-child.pid, kind); } catch (e) { if (e.code !== 'ESRCH') child.kill(kind); } };
  const stop = () => { if (killTimer) return; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000); };
  const abort = () => { error ||= failure('PYTHON_ENVIRONMENT_CANCELLED', 'Python environment preparation was cancelled.', 409); stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { error ||= failure('PYTHON_ENVIRONMENT_TIMEOUT', 'Python environment preparation timed out.', 408); stop(); }, timeoutMs);
  const append = (stream, chunk) => {
    if (error) return;
    bytes += chunk.length;
    if (bytes > maxOutputBytes) { error = failure('PYTHON_ENVIRONMENT_OUTPUT_LIMIT', 'Python environment output exceeded its limit.', 413); stop(); return; }
    const text = chunk.toString();
    if (stream === 'stdout') stdout += text; else stderr += text;
    try { onOutput?.({ stream, text }); } catch (e) { error = e; stop(); }
  };
  child.stdout.on('data', chunk => append('stdout', chunk));
  child.stderr.on('data', chunk => append('stderr', chunk));
  let result;
  try {
    try { if (child.pid) await onProcess?.({ pid: child.pid, stopConfirmed: false }); }
    catch { error ||= failure('PYTHON_ENVIRONMENT_PROCESS_OWNER_UNAVAILABLE', 'Python process ownership could not be saved.', 503); stop(); }
    result = await closed;
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
    await onProcess?.({ pid: child.pid || null, stopConfirmed: true });
  }
  if (error) throw error;
  if (result.exitCode !== 0) {
    if (/^sandbox-exec:|sandbox_apply/m.test(stderr)) throw failure('EXPERIMENT_SANDBOX_UNAVAILABLE', 'The OS could not apply the Python isolation profile.', 503);
    throw failure('PYTHON_ENVIRONMENT_COMMAND_FAILED', 'The isolated Python environment command failed.', 422);
  }
  return { stdout, stderr };
}

function budgets({ timeoutMs = 120000, maxOutputBytes = 1024 * 1024 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024) throw failure('PYTHON_ENVIRONMENT_BUDGET_INVALID', 'Invalid Python environment timeout or output budget.');
  return { timeoutMs, maxOutputBytes };
}

async function verifiedDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) throw failure('PYTHON_ENVIRONMENT_PATH_INVALID', 'A controlled absolute environment directory is required.');
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw failure('PYTHON_ENVIRONMENT_PATH_INVALID', 'The controlled environment directory must exist and cannot be a symlink.');
  return fs.realpath(directory);
}

async function verifyWheels(wheels) {
  if (!Array.isArray(wheels) || wheels.length > 30) throw failure('PYTHON_ENVIRONMENT_WHEEL_INVALID', 'At most 30 fixed local wheels are allowed.');
  let total = 0;
  const seen = new Set(); const verified = [];
  for (const wheel of wheels) {
    if (!wheel || !path.isAbsolute(wheel.path || '') || !/^[a-f0-9]{64}$/.test(wheel.sha256 || '') || !/^[A-Za-z0-9_.+-]+\.whl$/.test(path.basename(wheel.path))) throw failure('PYTHON_ENVIRONMENT_WHEEL_INVALID', 'Each wheel requires an absolute local wheel path and a SHA-256 digest.');
    const stat = await fs.lstat(wheel.path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw failure('PYTHON_ENVIRONMENT_WHEEL_INVALID', 'A wheel must be a regular local file of at most 32 MiB.');
    const realPath = await fs.realpath(wheel.path);
    total += stat.size;
    if (total > 128 * 1024 * 1024 || seen.has(realPath)) throw failure('PYTHON_ENVIRONMENT_WHEEL_INVALID', 'Wheel inputs exceed the budget or repeat a file.');
    seen.add(realPath);
    const digest = createHash('sha256').update(await fs.readFile(realPath)).digest('hex');
    if (digest !== wheel.sha256) throw failure('PYTHON_ENVIRONMENT_WHEEL_CHANGED', 'A local dependency wheel no longer matches its fixed digest.', 409);
    verified.push({ path: realPath, sha256: digest });
  }
  return verified;
}

function runtimePaths(interpreter) {
  const root = path.dirname(path.dirname(interpreter.realPath));
  const marker = `${path.sep}Cellar${path.sep}`;
  return [root, path.dirname(path.dirname(interpreter.configured)), ...(interpreter.realPath.includes(marker) ? [interpreter.realPath.split(marker)[0]] : [])];
}

function parseMetadata(stdout) {
  try {
    const result = JSON.parse(stdout.trim());
    if (!result.python?.version || !result.python?.executable || !Array.isArray(result.packages) || !/^[a-f0-9]{64}$/.test(result.installedMetadataSha256)) throw new Error();
    return { ...result, isolation: 'macos-sandbox-exec' };
  } catch { throw failure('PYTHON_ENVIRONMENT_METADATA_INVALID', 'Python did not return valid environment metadata.', 422); }
}

export async function probePythonEnvironmentCapability() {
  try {
    const interpreter = await configuredInterpreter();
    const applicability = await isOsSandboxApplicable();
    if (!applicability.ok) return { available: false, code: 'EXPERIMENT_SANDBOX_UNAVAILABLE', reason: 'Python requires an applicable macOS OS sandbox.' };
    const profile = pythonEnvironmentSandboxProfile({ runtimePaths: runtimePaths(interpreter), writable: false });
    const result = await runPython({ executable: interpreter.configured, args: ['-I', '-c', metadataScript], profile, ...budgets({ timeoutMs: 10000, maxOutputBytes: 1024 * 1024 }) });
    return { available: true, ...parseMetadata(result.stdout) };
  } catch (e) { return { available: false, code: e.code || 'PYTHON_RUNTIME_UNAVAILABLE', reason: e.message }; }
}

export async function validatePythonEnvironment({ directory, signal, beforeLaunch, onLaunch, onProcess, onOutput, timeoutMs, maxOutputBytes } = {}) {
  const limits = budgets({ timeoutMs, maxOutputBytes });
  const realDirectory = await verifiedDirectory(directory);
  const interpreter = await configuredInterpreter();
  const applicability = await isOsSandboxApplicable();
  if (!applicability.ok) throw failure('EXPERIMENT_SANDBOX_UNAVAILABLE', 'Python requires an applicable macOS OS sandbox.', 503);
  const pythonPath = path.join(realDirectory, 'bin', 'python');
  const profile = pythonEnvironmentSandboxProfile({ directory: realDirectory, runtimePaths: runtimePaths(interpreter), writable: false });
  const result = await runPython({ executable: pythonPath, args: ['-I', '-c', metadataScript], directory: realDirectory, profile, signal, beforeLaunch, onLaunch, onProcess, onOutput, ...limits });
  const metadata = parseMetadata(result.stdout);
  if (await fs.realpath(metadata.python.prefix).catch(() => null) !== realDirectory || await fs.realpath(metadata.python.executable).catch(() => null) !== interpreter.realPath) throw failure('PYTHON_ENVIRONMENT_IDENTITY_CHANGED', 'The prepared environment does not use the configured trusted interpreter.', 409);
  return metadata;
}

export async function preparePythonEnvironment({ directory, wheels = [], signal, beforeLaunch, onLaunch, onProcess, onOutput, timeoutMs, maxOutputBytes } = {}) {
  const limits = budgets({ timeoutMs, maxOutputBytes });
  const realDirectory = await verifiedDirectory(directory);
  if ((await fs.readdir(realDirectory)).length) throw failure('PYTHON_ENVIRONMENT_NOT_EMPTY', 'Preparation requires an empty controlled environment directory.', 409);
  const verified = await verifyWheels(wheels);
  if (verified.some(wheel => wheel.path.startsWith(`${realDirectory}${path.sep}`))) throw failure('PYTHON_ENVIRONMENT_WHEEL_INVALID', 'Fixed wheels must be outside the writable environment.');
  const interpreter = await configuredInterpreter();
  const applicability = await isOsSandboxApplicable();
  if (!applicability.ok) throw failure('EXPERIMENT_SANDBOX_UNAVAILABLE', 'Python requires an applicable macOS OS sandbox.', 503);
  cancelled(signal);
  await beforeLaunch?.();
  cancelled(signal);
  await fs.mkdir(path.join(realDirectory, '.python-home'));
  await fs.mkdir(path.join(realDirectory, '.python-tmp'));
  const profile = pythonEnvironmentSandboxProfile({ directory: realDirectory, runtimePaths: runtimePaths(interpreter), wheelPaths: verified.map(w => w.path) });
  const deadline = Date.now() + limits.timeoutMs;
  let outputBytes = 0;
  const output = item => { outputBytes += Buffer.byteLength(item.text); onOutput?.(item); };
  const options = { executable: interpreter.configured, directory: realDirectory, profile, signal, onLaunch, onProcess, onOutput: output,
    beforeLaunch: async () => { await beforeLaunch?.(); await verifyWheels(verified); cancelled(signal); } };
  const remaining = () => {
    if (Date.now() >= deadline) throw failure('PYTHON_ENVIRONMENT_TIMEOUT', 'Python environment preparation timed out.', 408);
    if (outputBytes >= limits.maxOutputBytes) throw failure('PYTHON_ENVIRONMENT_OUTPUT_LIMIT', 'Python environment output exceeded its limit.', 413);
    return { timeoutMs: deadline - Date.now(), maxOutputBytes: limits.maxOutputBytes - outputBytes };
  };
  const command = (args, overrides = {}) => runPython({ ...options, ...overrides, args, ...remaining() });
  if (verified.length) {
    const inspection = await command(['-I', '-c', wheelArchiveScript, ...verified.flatMap(wheel => [wheel.path, wheel.sha256])], {
      profile: pythonEnvironmentSandboxProfile({ directory: realDirectory, runtimePaths: runtimePaths(interpreter), wheelPaths: verified.map(wheel => wheel.path), writable: false })
    });
    let archive;
    try { archive = JSON.parse(inspection.stdout.trim()); } catch { /* Refuse unreadable inspection output. */ }
    if (archive?.valid !== true) throw failure('PYTHON_ENVIRONMENT_WHEEL_ARCHIVE_INVALID', 'Dependency wheel contents exceed the unpacked budget or contain unsafe ZIP entries.', 422);
  }
  await command(['-I', '-m', 'venv', '--without-pip', realDirectory]);
  if (verified.length) {
    const pip = ['-I', '-m', 'pip', '--isolated', '--python', path.join(realDirectory, 'bin', 'python')];
    await command([...pip, 'install', '--no-index', '--no-deps', '--no-cache-dir', '--disable-pip-version-check', '--no-compile', ...verified.map(w => w.path)]);
    await command([...pip, 'check']);
  }
  await verifyWheels(verified);
  const metadata = await validatePythonEnvironment({ directory: realDirectory, signal, beforeLaunch, onLaunch, onProcess, onOutput: output, ...remaining() });
  return metadata;
}
