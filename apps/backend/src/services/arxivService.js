import { promises as fs, createWriteStream } from 'fs';
import { pipeline, Transform } from 'stream';
import { promisify } from 'util';
import { Readable } from 'stream';
import { XMLParser } from 'fast-xml-parser';

const pipelineAsync = promisify(pipeline);

export function extractArxivId(input) {
  if (!input) return '';
  const trimmed = String(input).trim();
  const match = trimmed.match(/arxiv\.org\/(abs|pdf|e-print)\/([^?#/]+)/i);
  let id = match ? match[2] : trimmed;
  id = id.replace(/\.pdf$/i, '');
  id = id.replace(/v\d+$/i, '');
  return id;
}

export async function fetchArxivEntry(arxivId) {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'scienceprism/1.0' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) {
    throw new Error(`arXiv API failed: ${res.status}`);
  }
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const data = parser.parse(xml);
  const entry = Array.isArray(data?.feed?.entry) ? data.feed.entry[0] : data?.feed?.entry;
  if (!entry) return null;
  const authors = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
  const authorNames = authors.map((a) => a?.name).filter(Boolean);
  const published = entry.published || '';
  const year = published ? String(published).slice(0, 4) : '';
  return {
    title: String(entry.title || '').replace(/\s+/g, ' ').trim(),
    abstract: String(entry.summary || '').replace(/\s+/g, ' ').trim(),
    authors: authorNames,
    year,
    id: String(entry.id || ''),
    arxivId
  };
}

export function buildArxivBibtex(entry) {
  if (!entry) return '';
  const key = `arxiv:${entry.arxivId}`;
  const author = entry.authors.join(' and ');
  const year = entry.year || '2024';
  return `@article{${key},\n  title={${entry.title}},\n  author={${author}},\n  journal={arXiv preprint arXiv:${entry.arxivId}},\n  year={${year}}\n}`;
}

export async function downloadArxivSource(arxivId, outputPath, onProgress) {
  const url = `https://arxiv.org/e-print/${arxivId}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'scienceprism/1.0' },
    signal: AbortSignal.timeout(300_000)
  });
  if (!res.ok) {
    throw new Error(`arXiv download failed: ${res.status}`);
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  let received = 0;
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress) onProgress({ received, total });
      cb(null, chunk);
    }
  });
  const nodeStream = Readable.fromWeb(res.body);
  await pipelineAsync(nodeStream, progress, createWriteStream(outputPath));
}
