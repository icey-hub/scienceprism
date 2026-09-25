import { promises as fs, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import unzipper from 'unzipper';
import { readTemplateManifest, addTemplateToManifest } from '../services/templateService.js';
import { TEMPLATE_DIR } from '../config/constants.js';
import { ensureDir } from '../utils/fsUtils.js';
import { assertStorageName, safeJoin, sanitizeUploadPath } from '../utils/pathUtils.js';

export function registerHealthRoutes(fastify) {
  fastify.get('/api/health', async () => ({ ok: true }));

  fastify.get('/api/templates', async () => {
    const { templates, categories } = await readTemplateManifest();
    return { templates, categories };
  });

  fastify.post('/api/templates/upload', async (req, reply) => {
    await ensureDir(TEMPLATE_DIR);
    let templateId = '';
    let templateLabel = '';
    let hasZip = false;

    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'templateId') {
          templateId = String(part.value || '').trim();
          continue;
        }
        if (part.type === 'field' && part.fieldname === 'templateLabel') {
          templateLabel = String(part.value || '').trim();
          continue;
        }
        if (part.type !== 'file') continue;
        if (!templateId) {
          return reply.code(400).send({ ok: false, error: 'templateId is required before file.' });
        }
        try {
          assertStorageName(templateId);
        } catch {
          return reply.code(400).send({ ok: false, error: 'Invalid templateId.' });
        }
        hasZip = true;
        const templateRoot = path.join(TEMPLATE_DIR, templateId);
        await ensureDir(templateRoot);

        const zipStream = part.file.pipe(unzipper.Parse({ forceStream: true }));
        for await (const entry of zipStream) {
          const relPath = sanitizeUploadPath(entry.path);
          if (!relPath) { entry.autodrain(); continue; }
          const abs = safeJoin(templateRoot, relPath);
          if (entry.type === 'Directory') {
            await ensureDir(abs);
            entry.autodrain();
            continue;
          }
          await ensureDir(path.dirname(abs));
          await pipeline(entry, createWriteStream(abs));
        }
      }
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }

    if (!hasZip || !templateId) {
      return reply.code(400).send({ ok: false, error: 'Missing templateId or zip file.' });
    }

    await addTemplateToManifest({
      id: templateId,
      label: templateLabel || templateId,
      mainFile: 'main.tex',
      category: 'academic',
      description: templateLabel || templateId,
      descriptionEn: templateLabel || templateId,
      tags: [],
      author: 'User',
      featured: false,
    });

    return { ok: true, templateId };
  });
}
