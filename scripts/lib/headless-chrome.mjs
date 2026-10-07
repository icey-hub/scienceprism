import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cacheRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cache');
export const CHROME = process.env.SCIENCEPRISM_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Isolate each render from running Chrome instances and keep its profile in the repo. */
export async function runHeadlessChrome(args, { executable = CHROME, timeout = 30000 } = {}) {
  await fs.mkdir(cacheRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(cacheRoot, 'headless-chrome-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, [
        '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
        '--remote-debugging-pipe', `--user-data-dir=${profile}`, ...args
      ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let closing = false;
      let timedOut = false;
      const outputPaths = args.filter((arg) => /^--(?:print-to-pdf|screenshot)=/.test(arg))
        .map((arg) => arg.slice(arg.indexOf('=') + 1));
      const closeWhenRendered = () => {
        const complete = args.includes('--dump-dom') ? /<\/html>\s*$/.test(stdout)
          : outputPaths.length > 0 && outputPaths.every((file) => stderr.includes(`bytes written to file ${file}`));
        if (!complete || closing) return;
        closing = true;
        // Chrome on macOS can finish the CLI render yet keep the profile alive.
        // Close only this process via its private DevTools pipe after output is ready.
        child.stdio[3].write(`${JSON.stringify({ id: 1, method: 'Browser.close' })}\0`);
      };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.stdio[3].on('error', () => {}); // It may already be exiting normally.
      child.stdio[4].resume();
      child.stdout.on('data', (chunk) => { stdout += chunk; closeWhenRendered(); });
      child.stderr.on('data', (chunk) => { stderr += chunk; closeWhenRendered(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve(stdout);
        else reject(Object.assign(new Error(stderr || `Chrome exited with ${code ?? signal}`), { code, signal, stdout, stderr }));
      });
    });
  } catch (error) {
    throw new Error(`Chrome render failed (${error.code ?? error.signal ?? 'spawn'}): ${error.stderr || error.message}`, { cause: error });
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
}
