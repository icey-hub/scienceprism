import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPathAllowed, isSensitivePath } from '../harnessRuntime/capabilities.js';
import { HarnessRuntimeError } from '../harnessRuntime/errors.js';
import { isOsSandboxApplicable } from '../experimentRunner/adapters.js';
import { safeJoin } from '../../utils/pathUtils.js';

const fail = (code, message) => new HarnessRuntimeError(403, code, message);
const REPO = path.resolve(import.meta.dirname, '../../../../..');
const MAX_BYTES = 64 * 1024 * 1024;
const RESERVED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|HOME|TMPDIR|PATH|SHELL|XDG_.*)$/;

function executable(command) {
  if (typeof command !== 'string' || !command || /[\x00-\x1f]/.test(command)) throw fail('MCP_COMMAND_INVALID', 'A configured executable is required.');
  const candidates = path.isAbsolute(command) ? [command] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  throw fail('MCP_COMMAND_UNAVAILABLE', 'The configured MCP executable is unavailable.');
}

function copyInputs(source, target, policy, signal) {
  let bytes = 0, count = 0;
  const visit = relative => {
    signal?.throwIfAborted();
    for (const item of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, item.name);
      if (['project.json', '.compile'].includes(item.name) || isSensitivePath(file)
        || ['.agents', '.dsh'].includes(file.split('/')[0])) continue;
      const allowed = isPathAllowed(file, policy);
      const ancestor = policy.allowedPaths?.some(prefix => prefix.startsWith(`${file}/`));
      if (!allowed && !ancestor) continue;
      const original = path.join(source, file), destination = path.join(target, file);
      const stat = fs.lstatSync(original);
      if (stat.isSymbolicLink()) throw fail('MCP_PATH_DENIED', 'Symbolic links cannot enter the MCP input snapshot.');
      if (stat.isDirectory()) { fs.mkdirSync(destination, { recursive: true }); visit(file); continue; }
      if (!allowed) continue;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || ++count > 2000 || bytes + stat.size > MAX_BYTES) {
        throw fail('MCP_INPUT_RESTRICTED', 'MCP inputs must be bounded regular files without hard links.');
      }
      const fd = fs.openSync(original, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(fd);
        if (!current.isFile() || current.nlink !== 1 || current.size > 16 * 1024 * 1024) throw fail('MCP_PATH_DENIED', 'The MCP input changed during snapshotting.');
        const content = fs.readFileSync(fd); bytes += content.length;
        if (bytes > MAX_BYTES) throw fail('MCP_INPUT_RESTRICTED', 'The MCP input snapshot exceeds 64 MiB.');
        fs.writeFileSync(destination, content, { mode: 0o400, flag: 'wx' });
      } finally { fs.closeSync(fd); }
    }
  };
  visit('');
}

function codePermissions(server, binary, projectRoot) {
  const files = new Set([binary]), directories = new Set();
  if (binary === fs.realpathSync(process.execPath)) {
    directories.add(path.dirname(path.dirname(binary)));
    if (!server.args?.length || server.args[0].startsWith('-')) throw fail('MCP_COMMAND_RESTRICTED', 'The Node MCP profile requires a configured script without runtime flags.');
    const entry = fs.realpathSync(path.resolve(projectRoot, server.args[0]));
    if (!fs.statSync(entry).isFile()) throw fail('MCP_COMMAND_RESTRICTED', 'The configured Node entrypoint is not a file.');
    files.add(entry);
    // Only the explicitly configured package code and its installed dependencies
    // are readable. Never grant an entire project, repository or user home.
    const folder = path.dirname(entry);
    if (![projectRoot, REPO, homedir(), '/'].includes(folder) && !folder.startsWith(`${projectRoot}/`)
      && !folder.split(path.sep).some(part => ['.cache', '.scienceprism', '.git', '.ssh', '.aws', '.codex'].includes(part))) directories.add(folder);
    for (let parent = folder; parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const meta = path.join(parent, 'package.json'), modules = path.join(parent, 'node_modules');
      // Node probes absent package.json files as well as existing ones.
      // A sandbox denial is not equivalent to ENOENT during module resolution.
      files.add(meta);
      if (fs.existsSync(modules)) directories.add(fs.realpathSync(modules));
      if (parent === REPO || parent === projectRoot) break;
    }
  }
  return { files: [...files], directories: [...directories] };
}

const libraryCache = new Map();
async function runtimeLibraries(binary) {
  if (!libraryCache.has(binary)) libraryCache.set(binary, (async () => {
    const files = new Set(), visited = new Set(), pending = [binary];
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      if (visited.size > 256) throw fail('MCP_RUNTIME_RESTRICTED', 'The MCP runtime dependency list exceeds its limit.');
      visited.add(current);
      let text;
      try { ({ stdout: text } = await promisify(execFile)('/usr/bin/otool', ['-L', current], { timeout: 2000, maxBuffer: 131072 })); }
      catch { throw fail('MCP_RUNTIME_RESTRICTED', 'The MCP runtime libraries could not be inspected.'); }
      for (const line of text.split('\n').slice(1)) {
        let dependency = line.trim().split(' (compatibility')[0];
        if (dependency.startsWith('@rpath/')) {
          const name = dependency.slice(7), nearby = path.join(path.dirname(current), name);
          dependency = fs.existsSync(nearby) ? nearby : path.join(path.dirname(path.dirname(binary)), 'lib', name);
        }
        else if (dependency.startsWith('@loader_path/')) dependency = path.join(path.dirname(current), dependency.slice(13));
        if (!path.isAbsolute(dependency) || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
        let real;try { real = fs.realpathSync(dependency); } catch { throw fail('MCP_RUNTIME_RESTRICTED', 'A required MCP runtime library is unavailable.'); }
        files.add(dependency);files.add(real);pending.push(real);
      }
    }
    return [...files];
  })());
  return libraryCache.get(binary);
}

function readFilters({ files, directories }) {
  const filters = new Set(['(literal "/")']);
  for (const file of [...files, ...directories]) {
    filters.add(`(literal ${JSON.stringify(file)})`);
    if (directories.includes(file)) filters.add(`(subpath ${JSON.stringify(file)})`);
    for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) filters.add(`(literal ${JSON.stringify(parent)})`);
  }
  return [...filters].join(' ');
}

export async function prepareMcpStdio({ projectRoot, home, server, capabilityPolicy, signal, copyProject = false }) {
  const original = fs.realpathSync(projectRoot), privateRoot = fs.realpathSync(home);
  const input = path.join(privateRoot, 'input'), scratch = path.join(privateRoot, 'scratch');
  fs.mkdirSync(input); fs.mkdirSync(scratch);
  if (copyProject) copyInputs(original, input, capabilityPolicy, signal);
  const binary = executable(server.command), permissions = codePermissions(server, binary, original);
  const env = Object.fromEntries(Object.entries(server.env || {}).filter(([key]) => !RESERVED_ENV.test(key)));
  Object.assign(env, { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', HOME: scratch, TMPDIR: scratch,
    SHELL: '', XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' });
  // The local Node server has no network authority. Use its built-in crypto
  // defaults without reading or inheriting a host OpenSSL configuration.
  if (binary === fs.realpathSync(process.execPath)) env.OPENSSL_CONF = '/dev/null';
  const args = [...(server.args || [])];
  if (binary === fs.realpathSync(process.execPath)) args[0] = [...permissions.files][1];
  const checkCodeDirectories = directories => {
    for (const directory of directories) {
      const real = fs.realpathSync(directory);
      if ([original, REPO, homedir(), '/'].includes(real) || original.startsWith(`${real}/`)
        || real.startsWith(`${original}/`) || real.split(path.sep).some(part => ['.cache', '.scienceprism', '.git', '.ssh', '.aws', '.codex'].includes(part))) {
        throw fail('MCP_CODE_SCOPE_DENIED', 'An MCP code or runtime directory cannot expose project or private data.');
      }
    }
  };
  checkCodeDirectories(permissions.directories);
  const applicability = await isOsSandboxApplicable();
  signal?.throwIfAborted();
  if (applicability.ok) {
    const libraries = await runtimeLibraries(binary);
    if (libraries.some(file => file === original || file.startsWith(`${original}/`) || file.split(path.sep).some(part => ['.cache', '.scienceprism', '.ssh', '.aws', '.codex'].includes(part)))) {
      throw fail('MCP_RUNTIME_RESTRICTED', 'Runtime libraries cannot grant access to project or private data.');
    }
    const libraryDirectories = [...new Set(libraries.map(file => path.dirname(file)))];
    checkCodeDirectories(libraryDirectories);
    const readable = readFilters({ files: [...permissions.files, ...libraries, '/dev/null', '/dev/random', '/dev/urandom'],
      directories: [...permissions.directories, ...libraryDirectories, input, scratch,
        '/System/Library', '/usr/lib', '/usr/share/locale', '/private/var/db/timezone'] });
    const profile = ['(version 1)', '(allow default)', '(deny network*)', '(deny process-fork)', '(deny signal)',
      `(deny file-read* (require-not (require-any ${readable})))`,
      `(deny file-write* (require-not (subpath ${JSON.stringify(scratch)})))`].join('\n');
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, binary, ...args], cwd: input, env, isolation: 'macos-sandbox-exec' };
  }
  throw fail('MCP_SANDBOX_UNAVAILABLE', 'Local MCP servers require an available OS sandbox; the server was not started.');
}

export async function confirmMcpStopped(pid, { timeoutMs = 2000, inspect = pid => process.kill(pid, 0) } = {}) {
  if (pid === null || pid === undefined) return;
  const deadline = Date.now() + timeoutMs;
  do {
    try { inspect(pid); }
    catch (error) { if (error.code === 'ESRCH') return; throw fail('MCP_STOP_FAILED', 'The MCP process stop could not be confirmed.'); }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw fail('MCP_STOP_FAILED', 'The MCP process has not confirmed stopping; its private workspace is retained.');
}

/** Unknown or live retained processes must not be replaced by a second server. */
export function assertRetainedMcpStopped(projectRoot) {
  const runtime = safeJoin(projectRoot, '.scienceprism/mcp-runtime');
  if (!fs.existsSync(runtime)) return;
  for (const item of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink()) throw fail('MCP_STOP_FAILED', 'The retained MCP workspace is invalid.');
    const owner = safeJoin(projectRoot, `.scienceprism/mcp-runtime/${item.name}/process.json`);
    let record;
    try {
      const stat = fs.lstatSync(owner);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error();
      record = JSON.parse(fs.readFileSync(owner, 'utf8'));
    } catch { throw fail('MCP_STOP_FAILED', 'A retained MCP process has no trustworthy stop record.'); }
    if (record.stopConfirmed === true) continue;
    if (!Number.isSafeInteger(record.pid) || record.pid < 1) throw fail('MCP_STOP_FAILED', 'The retained MCP process identity is unknown.');
    try { process.kill(record.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { fs.writeFileSync(owner, JSON.stringify({ ...record, stopConfirmed: true }), { mode: 0o600 });continue; }
      throw fail('MCP_STOP_FAILED', 'The retained MCP process stop could not be inspected.');
    }
    throw fail('MCP_STOP_FAILED', 'A retained MCP server is still running; another server was not started.');
  }
}
