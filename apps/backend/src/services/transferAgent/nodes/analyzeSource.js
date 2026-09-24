import { promises as fs } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../projectService.js';
import { safeJoin } from '../../../utils/pathUtils.js';
import { listFilesRecursive } from '../../../utils/fsUtils.js';

/**
 * Recursively resolve \input{} and \include{} references,
 * returning the concatenated full content.
 */
async function resolveInputs(projectRoot, relPath, visited = new Set()) {
  if (visited.has(relPath)) return '';
  visited.add(relPath);

  const absPath = safeJoin(projectRoot, relPath);
  let content;
  try {
    content = await fs.readFile(absPath, 'utf8');
  } catch {
    return '';
  }

  // Match \input{...} and \include{...}
  const pattern = /\\(?:input|include)\{([^}]+)\}/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    result += content.slice(lastIndex, match.index);
    let ref = match[1].trim();
    // Add .tex extension if missing
    if (!path.extname(ref)) ref += '.tex';
    const childContent = await resolveInputs(projectRoot, ref, visited);
    result += childContent;
    lastIndex = pattern.lastIndex;
  }
  result += content.slice(lastIndex);
  return result;
}

/**
 * Parse section/subsection outline from LaTeX content.
 */
function parseOutline(content) {
  const outline = [];
  const pattern = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    outline.push({ level: match[1], title: match[2].trim() });
  }
  return outline;
}

/**
 * Collect asset references from LaTeX content.
 */
function collectAssets(content, allFiles) {
  const assets = { bib: [], images: [], styles: [], other: [] };

  // Collect \bibliography{} and \addbibresource{}
  const bibPattern = /\\(?:bibliography|addbibresource)\{([^}]+)\}/g;
  let match;
  while ((match = bibPattern.exec(content)) !== null) {
    const refs = match[1].split(',').map(r => r.trim());
    for (let ref of refs) {
      if (!path.extname(ref)) ref += '.bib';
      assets.bib.push(ref);
    }
  }

  // Collect \includegraphics paths
  const imgPattern = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;
  while ((match = imgPattern.exec(content)) !== null) {
    assets.images.push(match[1].trim());
  }

  // Collect .sty/.cls/.bst from file listing
  for (const f of allFiles) {
    const ext = path.extname(f.path).toLowerCase();
    if (['.sty', '.cls', '.bst'].includes(ext)) {
      assets.styles.push(f.path);
    }
  }

  return assets;
}

/**
 * analyzeSource node — reads source project, resolves inputs,
 * parses outline, collects assets.
 */
export async function analyzeSource(state) {
  const projectRoot = await getProjectRoot(state.sourceProjectId);
  const allFiles = await listFilesRecursive(projectRoot);

  // Resolve all \input/\include and get full content
  const fullContent = await resolveInputs(projectRoot, state.sourceMainFile);
  const outline = parseOutline(fullContent);
  const assets = collectAssets(fullContent, allFiles);

  return {
    sourceProjectRoot: projectRoot,
    sourceOutline: outline,
    sourceFullContent: fullContent,
    sourceAssets: assets,
    progressLog: `[analyzeSource] Parsed ${outline.length} sections, found ${assets.bib.length} bib files, ${assets.images.length} images, ${assets.styles.length} style files.`,
  };
}
