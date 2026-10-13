import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [outside, url] = process.argv.slice(2);
const blocked = operation => { try { operation();return false; } catch { return true; } };
const result = {
  copyRead: fs.readFileSync('safe/note.txt', 'utf8'),
  copyWriteBlocked: blocked(() => fs.writeFileSync('safe/note.txt', 'modified')),
  outsideReadBlocked: blocked(() => fs.readFileSync(outside, 'utf8')),
  outsideWriteBlocked: blocked(() => fs.writeFileSync(outside, 'modified')),
  forkBlocked: Boolean(spawnSync(process.execPath, ['-e', 'process.exit(0)']).error)
};
fs.writeFileSync(path.join(process.env.HOME, 'scratch.txt'), 'private output');
result.scratchWrite = true;
try { await fetch(url, { signal: AbortSignal.timeout(1000) });result.networkBlocked = false; }
catch { result.networkBlocked = true; }
console.log(JSON.stringify(result));
