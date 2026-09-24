import path from 'path';
import { promises as fs } from 'fs';
import { safeJoin, sanitizeUploadPath } from '../utils/pathUtils.js';
import { ensureDir } from '../utils/fsUtils.js';
import { resolveLLMConfig, callOpenAICompatible } from '../services/llmService.js';
import { getProjectRoot } from '../services/projectService.js';
import { applyProjectConstraintPolicy, hasCapability, resolveCapabilityPolicy } from '../services/harnessRuntime/capabilities.js';
import { getProjectConstraints } from '../services/projectHub/dashboard.js';

export function registerVisionRoutes(fastify) {
  fastify.post('/api/vision/latex', async (req) => {
    const parts = req.parts();
    let projectId = '';
    let mode = 'equation';
    let prompt = '';
    let llmConfig = null;
    let imageBuffer = null;
    let imageName = 'upload.png';
    let imageType = 'image/png';

    for await (const part of parts) {
      if (part.type === 'file') {
        imageName = part.filename || imageName;
        imageType = part.mimetype || imageType;
        const chunks = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        imageBuffer = Buffer.concat(chunks);
        continue;
      }
      if (part.type === 'field') {
        if (part.fieldname === 'projectId') projectId = String(part.value || '');
        if (part.fieldname === 'mode') mode = String(part.value || mode);
        if (part.fieldname === 'prompt') prompt = String(part.value || '');
        if (part.fieldname === 'llmConfig') {
          try {
            llmConfig = JSON.parse(String(part.value || '{}'));
          } catch {
            llmConfig = null;
          }
        }
      }
    }

    if (!imageBuffer) return { ok: false, error: 'Missing image.' };

    let assetPath = '';
    if (projectId) {
      // The uploaded image is stored inside the Project. It is the researcher's own
      // file rather than a model-authored change, so the risk is low, but the write
      // still has to be deniable: patch.propose is granted by default, so the
      // default flow is unchanged and a Project can revoke it.
      const constraints = await getProjectConstraints(projectId);
      const policy = applyProjectConstraintPolicy(resolveCapabilityPolicy({ configured: constraints.capabilities }), constraints);
      if (!hasCapability(policy, 'patch.propose')) {
        return { ok: false, code: 'CAPABILITY_DENIED', error: 'Storing a converted image in the project requires the patch.propose capability.' };
      }
      try {
        const projectRoot = await getProjectRoot(projectId);
        const safeName = sanitizeUploadPath(imageName) || `image_${Date.now()}.png`;
        const assetRel = path.join('assets', safeName);
        const abs = safeJoin(projectRoot, assetRel);
        await ensureDir(path.dirname(abs));
        await fs.writeFile(abs, imageBuffer);
        assetPath = assetRel.replace(/\\/g, '/');
      } catch {
        assetPath = '';
      }
    }

    const resolved = resolveLLMConfig(llmConfig);
    const imageBase64 = imageBuffer.toString('base64');
    const userInstruction = (() => {
      switch (mode) {
        case 'table':
          return 'Convert the table in the image to LaTeX tabular/table. Output only the table environment (no document, no preamble, no extra text).';
        case 'figure':
          return `Generate a LaTeX figure environment using ${assetPath || 'the image file'} with caption and label. Output only the figure environment (no document, no extra text).`;
        case 'algorithm':
          return 'Convert the algorithm in the image to LaTeX algorithm/algorithmic. Output only the algorithm environment (no document, no extra text).';
        case 'ocr':
          return 'Extract the text from the image and return clean LaTeX-safe text. Output only text.';
        default:
          return 'Convert the formula in the image to LaTeX equation environment. Output only the equation environment (no document, no extra text).';
      }
    })();

    const system = 'You are a LaTeX conversion engine. Return only LaTeX or plain text without explanations.';
    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt ? `${userInstruction}\n\nUser note: ${prompt}` : userInstruction },
          { type: 'image_url', image_url: { url: `data:${imageType};base64,${imageBase64}` } }
        ]
      }
    ];

    const result = await callOpenAICompatible({
      messages,
      model: resolved.model,
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, latex: result.content, assetPath };
  });
}
