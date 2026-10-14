import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { safeJoin } from '../utils/pathUtils.js';
import { ensureDir } from '../utils/fsUtils.js';
import { getProjectRoot } from '../services/projectService.js';
import { createTableFigure } from '../services/figureArtifacts/index.js';
import { ResearchWorkflowError } from '../services/researchWorkflow/errors.js';
import { generateGptImage, resolveImageConfig } from '../services/imageGenerationService.js';
import { applyProjectConstraintPolicy, hasCapability, resolveCapabilityPolicy } from '../services/harnessRuntime/capabilities.js';
import { getProjectConstraints } from '../services/projectHub/dashboard.js';

export function registerPlotRoutes(fastify, { render } = {}) {
  fastify.post('/api/plot/gpt-image-2', async (req) => {
    const { projectId, prompt, size, quality, llmConfig } = req.body || {};
    if (!projectId) return { ok: false, error: 'Missing projectId.' };
    const constraints = await getProjectConstraints(projectId);
    const policy = applyProjectConstraintPolicy(resolveCapabilityPolicy({ configured: constraints.capabilities }), constraints);
    if (!hasCapability(policy, 'patch.propose')) {
      return { ok: false, code: 'CAPABILITY_DENIED', error: 'Storing a generated image requires the patch.propose capability.' };
    }

    try {
      const projectRoot = await getProjectRoot(projectId);
      const buffer = await generateGptImage({ prompt, size, quality, config: resolveImageConfig(llmConfig) });
      const assetRel = path.posix.join('assets', 'images', `gpt-image-2-${crypto.randomUUID()}.png`);
      const abs = safeJoin(projectRoot, assetRel);
      await ensureDir(path.dirname(abs));
      await fs.writeFile(abs, buffer, { flag: 'wx' });
      return { ok: true, assetPath: assetRel };
    } catch (error) {
      return { ok: false, error: error.message || 'Image generation failed.' };
    }
  });

  fastify.post('/api/plot/from-table', async (req, reply) => {
    const body = req.body || {};
    try {
      if (typeof body.projectId !== 'string' || !body.projectId) throw new ResearchWorkflowError(400, 'PROJECT_REQUIRED', '请选择项目后使用固定图产物服务。');
      if (body.prompt !== undefined && body.prompt !== '' && body.prompt !== null || body.plotCode !== undefined && body.plotCode !== '' && body.plotCode !== null) {
        throw new ResearchWorkflowError(400, 'FIGURE_STRUCTURED_INPUT_REQUIRED', '自由提示词/绘图代码已停用，请使用图型、布局、标题、轴标签和预设配色控件。');
      }
      const allowed = ['projectId', 'tableLatex', 'sourcePath', 'chartType', 'layout', 'style', 'title', 'unit', 'sampleSize', 'prompt', 'plotCode', 'filename', 'llmConfig', 'retries'];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw new ResearchWorkflowError(400, 'FIGURE_TABLE_INPUT_INVALID', '旧表格入口包含未知字段，请使用统一Figures接口。');
      if (body.filename !== undefined && (typeof body.filename !== 'string' || body.filename.length > 200 || /[\x00-\x1f\x7f]/.test(body.filename))) throw new ResearchWorkflowError(400, 'FIGURE_TABLE_INPUT_INVALID', '旧文件名只能作为200字内的显示标签。');
      const input = { tableLatex: body.tableLatex, chartType: body.chartType || 'bar', layout: body.layout || 'single',
        ...(body.style !== undefined ? { style: body.style } : body.title !== undefined ? { style: { title: body.title } } : {}),
        ...Object.fromEntries(['sourcePath', 'unit', 'sampleSize'].filter(key => body[key] !== undefined).map(key => [key, body[key]])) };
      const figure = await createTableFigure(body.projectId, input, { actor: 'human', ...(render ? { render } : {}) });
      return { ok: true, figure, assetPath: figure.files.png.path,
        deprecation: { message: '此兼容入口已使用唯一Figures固定模板；未调用模型，也未执行提示词或用户代码。', ignoredFields: ['llmConfig', 'retries'].filter(key => body[key] !== undefined), ...(body.filename ? { requestedLabel: body.filename } : {}) } };
    } catch (error) {
      if (error instanceof ResearchWorkflowError) return reply.code(error.statusCode).send({ ok: false, code: error.code, error: error.message });
      req.log?.error?.(error); return reply.code(500).send({ ok: false, error: '图产物服务暂不可用。' });
    }
  });
}
