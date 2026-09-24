import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');

const { FIGURES, buildSvg, OUTPUT_DIR } = await import(path.join(repoRoot, 'scripts', 'build-diagrams.mjs'));

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', 'artifact is not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('every committed SVG matches what the generator produces', async () => {
  for (const name of Object.keys(FIGURES)) {
    const committed = await readFile(path.join(OUTPUT_DIR, `${name}.svg`), 'utf8');
    assert.equal(
      committed,
      buildSvg(name),
      `${name}.svg no longer matches the generator; run: node scripts/build-diagrams.mjs`
    );
  }
});

test('every figure has a rasterised PNG with the declared dimensions', async () => {
  for (const name of Object.keys(FIGURES)) {
    const match = buildSvg(name).match(/width="(\d+)" height="(\d+)"/);
    const buffer = await readFile(path.join(OUTPUT_DIR, `${name}.png`));

    // The PNG is intentionally not byte-compared: headless Chrome output can
    // differ across versions. Dimensions plus a non-trivial size still catch a
    // missing or truncated render, and the SVG comparison above catches drift.
    assert.ok(buffer.length > 2000, `${name}.png looks empty or truncated`);
    const size = pngSize(buffer);
    assert.equal(size.width, Number(match[1]), `${name}.png width does not match the SVG`);
    assert.equal(size.height, Number(match[2]), `${name}.png height does not match the SVG`);
  }
});

test('the generator covers the agreed benchmark set and rejects unknown figures', () => {
  assert.deepEqual(
    Object.keys(FIGURES).sort(),
    ['cell-structure', 'comparison-chart', 'module-graph', 'sequence-flow'],
    'the reference set changed; update drawing-comparison.md in the same commit'
  );
  assert.throws(() => buildSvg('no-such-figure'), /Unknown figure/);
});
