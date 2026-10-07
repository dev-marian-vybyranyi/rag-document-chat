import type { ChatSource } from './types';

export function describeSource(source: ChatSource): string {
  return source.page === null ? source.filename : `${source.filename}, page ${source.page}`;
}

export function describeMatch(score: number | null): string {
  if (score === null) return 'Found by keyword match';
  return `Similarity ${Math.round(score * 100)}%`;
}

export function formatPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
