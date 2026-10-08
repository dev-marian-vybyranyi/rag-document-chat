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
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatScoreAgainst(score: number, required: number): [string, string] {
  const whole = [formatPercent(score), formatPercent(required)] as [string, string];
  const hidden = whole[0] === whole[1] && score !== required;
  if (!hidden) return whole;
  return [`${(score * 100).toFixed(1)}%`, `${(required * 100).toFixed(1)}%`];
}
