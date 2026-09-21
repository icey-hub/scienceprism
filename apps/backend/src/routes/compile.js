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
    const task = await createTask(projectId, {
      kind: 'compile',
      title: `Compile ${mainFile}`,
      status: 'running',
      progress: 10,
      metadata: { projectId, mainFile, engine },
      log: [`Compilation started with ${engine}.`]
    });
    try {
      const result = await runCompile({ projectId, mainFile, engine });
      const finalTask = await updateTask(projectId, task.id, {
        status: result.ok ? 'completed' : 'failed',
        progress: 100,
        error: result.ok ? null : { message: result.error || 'Compilation failed.' },
        log: [...task.log, ...(result.log ? result.log.split('\n').slice(-200) : []), result.ok ? 'Compilation completed.' : 'Compilation failed.']
      });
      return { ...result, taskId: finalTask.id };
    } catch (error) {
      await updateTask(projectId, task.id, { status: 'failed', progress: 100, error: { message: error.message }, log: [...task.log, error.message] });
      throw error;
    }
  });
}
