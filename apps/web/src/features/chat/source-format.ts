import type { CodeLocation } from '../documents/api';
import type { ChatSource } from './types';

export const OVERVIEW_PATH = 'REPOSITORY_OVERVIEW';

export function describeLines(code: CodeLocation): string | null {
  if (code.startLine === null || code.endLine === null) return null;
  return code.startLine === code.endLine
    ? `${code.startLine}`
    : `${code.startLine}-${code.endLine}`;
}

export function describeLocation(source: {
  filename: string;
  page: number | null;
  code?: CodeLocation;
}): string {
  const { code } = source;
  if (!code) {
    return source.page === null ? source.filename : `${source.filename}, page ${source.page}`;
  }
  if (code.path === OVERVIEW_PATH) return `Overview of ${source.filename}`;
  const lines = describeLines(code);
  return lines ? `${code.path}:${lines}` : code.path;
}

export function describeSource(source: ChatSource): string {
  return describeLocation(source);
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
