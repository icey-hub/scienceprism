// Process-local ownership only. Missing owners must never be reported as stopped.
const active = new Map();
const keyFor = (projectId, taskId) => JSON.stringify([projectId, taskId]);

export function registerCompileCancellation(projectId, taskId) {
  const key = keyFor(projectId, taskId);
  if (active.has(key)) throw new Error('Compile task already registered.');
  const controller = new AbortController();
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const entry = { controller, done, accepting: true };
  active.set(key, entry);
  return {
    signal: controller.signal,
    seal() { entry.accepting = false; },
    finish(error) {
      active.delete(key);
      complete(error);
    }
  };
}

export async function cancelActiveCompile(projectId, taskId) {
  const entry = active.get(keyFor(projectId, taskId));
  if (!entry) throw new Error('Compile task is not active in this server; refresh its status.');
  if (entry.accepting) entry.controller.abort();
  // Includes child close, workspace cleanup, and persistence of the final task.
  const error = await entry.done;
  if (error) throw error;
}
