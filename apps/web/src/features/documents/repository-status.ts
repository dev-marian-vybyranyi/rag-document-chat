import type { DocumentItem, IngestionProgress } from './api';

const GITHUB_PREFIX = 'https://github.com/';
const SHORT_SHA_LENGTH = 7;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function safeGithubUrl(url: string | null): string | null {
  return url !== null && url.startsWith(GITHUB_PREFIX) ? url : null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function isCommitSha(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{40}$/.test(value);
}

export function commitUrl(document: DocumentItem): string | null {
  const base = safeGithubUrl(document.repoUrl);
  if (!base || !isCommitSha(document.commitSha)) return null;
  return `${base}/tree/${document.commitSha}`;
}

export function describeProgress(progress: IngestionProgress | null): string {
  if (!progress) return 'Processing…';
  switch (progress.phase) {
    case 'downloading':
      return 'Downloading from GitHub…';
    case 'reading':
      return 'Reading files…';
    case 'embedding':
      return progress.total > 0
        ? `Indexing: ${progress.done} of ${plural(progress.total, 'passage')}`
        : 'Indexing…';
  }
}

export function progressFraction(progress: IngestionProgress | null): number | null {
  if (!progress || progress.phase !== 'embedding' || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

export function describeRepositoryCounts(document: DocumentItem): string {
  const parts: string[] = [];
  if (document.fileCount !== null) parts.push(plural(document.fileCount, 'file'));
  parts.push(plural(document.chunkCount, 'passage'));
  return parts.join(' · ');
}
