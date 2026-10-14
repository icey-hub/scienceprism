import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'scienceprism-citations-'));
process.env.SCIENCEPRISM_DATA_DIR = data;
const { auditCitations, readCitationManuscript } = await import('../src/services/projectHub/citationAudit.js');
const { getWritingQuality } = await import('../src/services/projectHub/writingQuality.js');
const { importPaper } = await import('../src/services/projectHub/paperLibrary.js');
after(async () => fs.rm(data, { recursive: true, force: true }));
const file = (path, content) => ({ path, content });
const bib = '@article{a,title={真实论文},doi={10.1234/ABC},year={2025}}\n@article{b,title={Arxiv},archiveprefix={arXiv},eprint={2501.12345v2}}';
async function fixture(id) { const root = path.join(data, id); await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({ id, name: id })); return root; }
test('real TeX occurrences/options/comments/verbatim; library keys stay candidates and exact identifiers link sources', () => {
  const tex = String.raw`% \cite{commented}
\citep[see][p.2]{a,b}
\citet*{a} \parencite{b} \textcite{a} \autocite{b}
\verb|\cite{inverb}| \verb*+\cite{inverb2}+
\begin{verbatim}
\cite{inblock}
\end{verbatim}
% \begin{verbatim}
\cite{libraryOnly}
\bibliography{refs}
`;
  const result = auditCitations([file('main.tex', tex), file('refs.bib', bib)], [
    { id: 'doi-paper', title: 'DOI source', doi: 'https://doi.org/10.1234/abc', citationKey: 'different' },
    { id: 'arxiv-paper', title: 'Arxiv source', arxivId: '2501.12345v1' },
    { id: 'candidate', title: 'Library only', citationKey: 'libraryOnly', bibtex: '@article{libraryOnly,title={Not in manuscript}}' }
  ]);
  assert.deepEqual(result.citedKeys, ['a', 'b', 'libraryOnly']); assert.deepEqual(result.knownKeys, ['a', 'b']); assert.deepEqual(result.missingKeys, ['libraryOnly']); assert.equal(result.ok, false);
  assert.deepEqual(result.rows[0].occurrences, [{ path: 'main.tex', line: 2 }, { path: 'main.tex', line: 3 }, { path: 'main.tex', line: 3 }]);
  assert.equal(result.rows[0].bibEntries[0].line, 1); assert.equal(result.rows[0].papers[0].match, 'identifier'); assert.equal(result.rows[1].papers[0].id, 'arxiv-paper');
  assert.equal(result.rows[2].status, 'missing-bib'); assert.equal(result.rows[2].papers[0].match, 'key');
  assert.deepEqual(result.summary, { total: 3, resolved: 2, missing: 1, conflicts: 0, unlinked: 0 });
});
test('actual Bib imports, conflicts, inline bibitems and unsupported syntax cannot become green', () => {
  const unlinked = auditCitations([file('main.tex', '\\cite{a}'), file('refs.bib', bib)]); assert.equal(unlinked.rows[0].status, 'unlinked-bib'); assert.equal(unlinked.ok, false);
  const duplicate = auditCitations([file('main.tex', '\\addbibresource[location=local]{refs.bib}\\cite{a}'), file('refs.bib', `${bib}\n@article{a,title={Different},doi={10.9999/other}}`)]);
  assert.equal(duplicate.rows[0].status, 'conflict'); assert.equal(duplicate.rows[0].bibEntries.length, 2); assert.equal(duplicate.ok, false);
  const inline = auditCitations([file('main.tex', '\\cite[12]{local}\\begin{thebibliography}{9}\n\\bibitem[Author 2025]{local} Author. Real inline reference.\\end{thebibliography}')]);
  assert.equal(inline.rows[0].status, 'inline'); assert.equal(inline.ok, true); assert.equal(inline.rows[0].bibEntries[0].line, 2);
  const invalid = auditCitations([file('main.tex', '\\cite{a}\\bibliography{refs}'), file('refs.bib', '@article{a,title={broken}')]); assert.equal(invalid.ok, false); assert.ok(invalid.issues.some(i => i.code === 'BIB_PARSE_FAILED'));
  const definition = auditCitations([file('main.tex', String.raw`\newcommand{\importRefs}{\addbibresource{refs.bib}} \cite{a}`), file('refs.bib', bib)]); assert.equal(definition.rows[0].status, 'unlinked-bib');
  const macro = auditCitations([file('main.tex', '\\cites{a}{b}\\cite{\\keyMacro}\\bibliography{\\resourceMacro}')]); assert.equal(macro.ok, false); assert.ok(macro.issues.some(i => i.code === 'CITATION_COMMAND_UNSUPPORTED'));
});
test('bounded read excludes private/cache/assets, rejects symlink and oversized file without silently passing', async () => {
  const root = await fixture('bounded'); await fs.writeFile(path.join(root, 'main.tex'), '\\cite{a}\\bibliography{refs}'); await fs.writeFile(path.join(root, 'refs.bib'), bib);
  for (const dir of ['.scienceprism', '.openprism', '.git', 'node_modules', 'assets', 'cache']) { await fs.mkdir(path.join(root, dir)); await fs.writeFile(path.join(root, dir, 'ignored.tex'), '\\cite{not-real}'); }
  await fs.writeFile(path.join(root, 'too-large.tex'), 'x'.repeat(2 * 1024 * 1024 + 1)); await fs.symlink(path.join(root, 'refs.bib'), path.join(root, 'symlink.bib'));
  const snapshot = await readCitationManuscript('bounded'); assert.deepEqual(snapshot.files.map(f => f.path), ['main.tex', 'refs.bib']);
  assert.ok(snapshot.issues.some(i => i.code === 'MANUSCRIPT_SYMLINK_REJECTED')); assert.ok(snapshot.issues.some(i => i.code === 'MANUSCRIPT_SIZE_LIMIT'));
  const audit = auditCitations(snapshot.files, [], snapshot); assert.equal(audit.rows[0].status, 'resolved'); assert.equal(audit.ok, false);
});
test('writing-quality owner uses real manuscript Bib, never PaperLibrary Bib alone', async () => {
  const root = await fixture('quality'); await fs.writeFile(path.join(root, 'main.tex'), '\\cite{onlyLibrary}');
  await importPaper('quality', { title: 'Source candidate', authors: ['Author'], doi: '10.1234/real', citationKey: 'onlyLibrary', bibtex: '@article{onlyLibrary,title={Source candidate},doi={10.1234/real}}' });
  const missing = await getWritingQuality('quality'); assert.deepEqual(missing.citations.missingKeys, ['onlyLibrary']); assert.equal(missing.citations.rows[0].papers[0].match, 'key'); assert.equal(missing.overall, 'needs-review');
  await fs.writeFile(path.join(root, 'refs.bib'), '@article{onlyLibrary,title={Source candidate},doi={10.1234/real}}'); await fs.appendFile(path.join(root, 'main.tex'), '\\addbibresource{refs.bib}');
  const resolved = await getWritingQuality('quality'); assert.equal(resolved.citations.ok, true); assert.equal(resolved.citations.rows[0].status, 'resolved'); assert.equal(resolved.citations.rows[0].papers[0].match, 'identifier');
});
