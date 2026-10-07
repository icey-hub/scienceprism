import { randomUUID } from 'node:crypto';
import { registerCompileCancellation } from '../services/compileCancellation.js';
import { runCompile, SUPPORTED_ENGINES } from '../services/compileService.js';
import { createTask, updateTask } from '../services/projectHub/taskCenter.js';

export function registerCompileRoutes(fastify) {
  fastify.post('/api/compile', async (req) => {
    const { projectId, mainFile = 'main.tex', engine = 'pdflatex' } = req.body || {};
    if (!projectId) {
      return { ok: false, error: 'Missing projectId.' };
    }
    if (!SUPPORTED_ENGINES.includes(engine)) {
      return { ok: false, error: `Unsupported engine: ${engine}. Supported: ${SUPPORTED_ENGINES.join(', ')}` };
    }
    const taskId = `task-${randomUUID()}`;
    const cancellation = registerCompileCancellation(projectId, taskId);
    let task;
    let failure;
    try {
      task = await createTask(projectId, {
        id: taskId,
        kind: 'compile',
        title: `Compile ${mainFile}`,
        status: 'running',
        progress: 10,
        metadata: { projectId, mainFile, engine },
        log: [`Compilation started with ${engine}.`]
      });
      let result = await runCompile({ projectId, mainFile, engine, signal: cancellation.signal });
      // Linearize completion before writing its status; a later cancel waits, not overwrites.
      cancellation.seal();
      if (cancellation.signal.aborted && !result.cancelled) {
        const { pdf, ...withoutPdf } = result;
        result = { ...withoutPdf, ok: false, cancelled: true, code: 'COMPILE_CANCELLED', error: 'Compilation cancelled.' };
      }
      const finalTask = await updateTask(projectId, task.id, {
        status: result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed',
        progress: 100,
        metadata: { ...task.metadata, ...(result.inputSnapshot ? { inputSnapshot: result.inputSnapshot } : {}) },
        error: result.ok ? null : { message: result.error || 'Compilation failed.' },
        log: [...task.log, ...(result.log ? result.log.split('\n').slice(-200) : []), result.cancelled ? 'Compilation cancelled.' : result.ok ? 'Compilation completed.' : 'Compilation failed.']
      });
      return { ...result, taskId: finalTask.id };
    } catch (error) {
      failure = error;
      cancellation.seal();
      if (task) await updateTask(projectId, task.id, { status: 'failed', progress: 100, error: { message: error.message }, log: [...task.log, error.message] });
      throw error;
    } finally {
      cancellation.finish(failure);
    }
  });
}
