import fastifyStatic from '@fastify/static';
import { basename } from 'node:path';

export async function registerFrontendStatic(app, root) {
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    // Resolve files on request, so a new build does not require restarting the API.
    wildcard: true,
    setHeaders(response, file) {
      if (basename(file) === 'index.html') response.setHeader('Cache-Control', 'no-cache');
    }
  });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    if (pathname.startsWith('/api') || pathname.startsWith('/assets/')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}
