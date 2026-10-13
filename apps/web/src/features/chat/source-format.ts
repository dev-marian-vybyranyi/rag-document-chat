import type { CodeLocation, MeetingLocation } from '../documents/api';
import { formatClock } from '../documents/meeting-status';
import type { ChatSource } from './types';

export const OVERVIEW_PATH = 'REPOSITORY_OVERVIEW';

export function describeLines(code: CodeLocation): string | null {
  if (code.startLine === null || code.endLine === null) return null;
  return code.startLine === code.endLine
    ? `${code.startLine}`
    : `${code.startLine}-${code.endLine}`;
}

const SPEAKERS_NAMED = 2;

export function describeSpeakers(speakers: string[]): string {
  const named = speakers.slice(0, SPEAKERS_NAMED).join(', ');
  const more = speakers.length - SPEAKERS_NAMED;
  return more > 0 ? `${named} +${more}` : named;
}

export function isMeetingNotes(meeting: MeetingLocation): boolean {
  return meeting.startMs === null;
}

export function describeMeetingPart(meeting: MeetingLocation): string {
  if (meeting.startMs === null) return 'Meeting notes';
  const end =
    meeting.endMs !== null && meeting.endMs > meeting.startMs
      ? `–${formatClock(meeting.endMs)}`
      : '';
  return `Transcript ${formatClock(meeting.startMs)}${end}`;
}

function describeMeetingSource(filename: string, meeting: MeetingLocation): string {
  if (meeting.startMs === null) return `${filename} · notes`;
  const speakers = describeSpeakers(meeting.speakers);
  return `${filename} · ${formatClock(meeting.startMs)}${speakers ? ` · ${speakers}` : ''}`;
}

export function describeLocation(source: {
  filename: string;
  page: number | null;
  code?: CodeLocation;
  meeting?: MeetingLocation;
}): string {
  const { code } = source;
  if (!code && source.meeting) return describeMeetingSource(source.filename, source.meeting);
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
