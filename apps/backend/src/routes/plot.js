import path from 'path';
import { safeJoin, sanitizeUploadPath } from '../utils/pathUtils.js';
import { ensureDir } from '../utils/fsUtils.js';
import { getProjectRoot } from '../services/projectService.js';
import { resolveLLMConfig, callOpenAICompatible } from '../services/llmService.js';
import { runPythonPlot } from '../services/plotService.js';
import { applyProjectConstraintPolicy, hasCapability, resolveCapabilityPolicy } from '../services/harnessRuntime/capabilities.js';
import { getProjectFeatureFlags } from '../services/featureFlags.js';
import { getProjectConstraints } from '../services/projectHub/dashboard.js';

export function registerPlotRoutes(fastify) {
  fastify.post('/api/plot/from-table', async (req) => {
    const { projectId, tableLatex, chartType, title, prompt, filename, llmConfig, retries } = req.body || {};
    if (!projectId) return { ok: false, error: 'Missing projectId.' };
    if (!tableLatex) return { ok: false, error: 'Missing tableLatex.' };

    // This route asks a model to write Python and then executes it, which is code
    // execution. It therefore goes through the same admission control as a
    // controlled Experiment Run: the Project must grant experiment.execute and
    // the execution flag must be on. Before this it ran model-authored code with
    // no gate at all, while the Experiment Runner required two human decisions.
    const constraints = await getProjectConstraints(projectId);
    const policy = applyProjectConstraintPolicy(resolveCapabilityPolicy({ configured: constraints.capabilities }), constraints);
    if (!hasCapability(policy, 'experiment.execute')) {
      return {
        ok: false,
        code: 'CAPABILITY_DENIED',
        error: 'Generating and executing plot code requires the project capability experiment.execute.'
      };
    }
    const flags = await getProjectFeatureFlags(projectId);
    if (flags.experimentExecution !== true) {
      return {
        ok: false,
        code: 'FEATURE_FLAG_DISABLED',
        error: 'Plot code execution is disabled by the experimentExecution feature flag.'
      };
    }

    const projectRoot = await getProjectRoot(projectId);
    const safeNameBase = sanitizeUploadPath(filename || `plot_${Date.now()}.png`) || `plot_${Date.now()}.png`;
    const ext = path.extname(safeNameBase);
    const finalName = ext ? safeNameBase : `${safeNameBase}.png`;
    const assetRel = path.join('assets', 'plots', finalName);
    const abs = safeJoin(projectRoot, assetRel);
    await ensureDir(path.dirname(abs));

    const resolved = resolveLLMConfig(llmConfig);
    if (!resolved.apiKey) {
      return { ok: false, error: 'SCIENCEPRISM_LLM_API_KEY not set' };
    }
    const baseSystem = [
      'You generate python plotting code using matplotlib (and seaborn if available).',
      'You are given: rows (list of rows), header (list of column names).',
      'If pandas is available, df and df_numeric are provided; otherwise df is None.',
      'Do not import packages. Do not call plt.savefig.',
      'Use chart_type if helpful.',
      'Return ONLY python code.'
    ].join(' ');

    const buildUser = (note, errorText, lastCode) => [
      `chart_type: ${chartType || 'bar'}`,
      note ? `user_prompt: ${note}` : '',
      errorText ? `runtime_error:\n${errorText}` : '',
      lastCode ? `previous_code:\n${lastCode}` : ''
    ].filter(Boolean).join('\n');

    let plotCode = '';
    let lastError = '';
    const maxRetries = Math.min(5, Math.max(0, Number(retries ?? 2)));
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const codeRes = await callOpenAICompatible({
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: buildUser(prompt, lastError, plotCode) }
        ],
        model: resolved.model,
        endpoint: resolved.endpoint,
        apiKey: resolved.apiKey
      });
      if (!codeRes.ok || !codeRes.content) {
        return { ok: false, error: codeRes.error || 'Plot code generation failed.' };
      }
      plotCode = String(codeRes.content)
        .replace(/```python/g, '')
        .replace(/```/g, '')
        .trim();

      const payload = {
        tableLatex,
        chartType,
        title,
        outputPath: abs,
        plotCode
      };
      const result = await runPythonPlot(payload);
      if (result.ok) {
        return { ok: true, assetPath: assetRel.replace(/\\/g, '/') };
      }
      lastError = result.error || 'Plot render failed.';
    }
    return { ok: false, error: lastError || 'Plot render failed.' };
  });
}
