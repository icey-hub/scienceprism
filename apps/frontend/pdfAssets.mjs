import { readdirSync, readFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep PDF fonts, CMaps and codecs local, versioned with the worker.
export function pdfAssets() {
  const root = fileURLToPath(new URL('../../node_modules/pdfjs-dist/', import.meta.url));
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const prefix = `pdfjs/${version}/`;
  const files = new Map([[`${prefix}LICENSE`, join(root, 'LICENSE')]]);
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const name of readdirSync(join(root, dir))) {
      files.set(`${prefix}${dir}/${name}`, join(root, dir, name));
    }
  }
  return {
    name: 'local-pdf-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get((req.url || '').split('?')[0].slice(1));
        if (!file) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    buildStart() {
      for (const [fileName, file] of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
    }
  };
}
