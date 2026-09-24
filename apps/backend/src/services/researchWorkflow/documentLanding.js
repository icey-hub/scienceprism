import path from 'node:path';

/**
 * R-15 / U-21: documents the research tool produces land under `aidoc/`, never
 * inside the agent-governance docs.
 *
 * This used to hold only by accident: the driver inherited
 * `SCIENCEPRISM_DATA_DIR` from `.env`, which is gitignored, so a fresh clone
 * produced documents wherever the default pointed. The policy lives here so the
 * driver, and a test, can both rely on it.
 */
export const DOCUMENT_LANDING_DIR_NAME = 'aidoc';

/** The directory tool-produced documents land in. */
export function resolveDocumentLandingDir(repoRoot, { override } = {}) {
  if (override) return path.resolve(String(override));
  return path.join(path.resolve(String(repoRoot)), DOCUMENT_LANDING_DIR_NAME);
}

/**
 * Returns the document's path relative to the landing directory, or throws when
 * it is aimed anywhere else.
 */
export function assertDocumentLandingPath(absolutePath, landingDir) {
  const relative = path.relative(path.resolve(landingDir), path.resolve(String(absolutePath)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `R-15: a tool-produced document must land under ${DOCUMENT_LANDING_DIR_NAME}/, got ${absolutePath}`
    );
  }
  return relative.split(path.sep).join('/');
}
