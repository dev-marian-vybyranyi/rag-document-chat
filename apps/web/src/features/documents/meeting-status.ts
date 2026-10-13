import type { DocumentItem, MeetingNotes } from './api';

const SPEAKERS_SHOWN = 8;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 60)} h ${pad(rest)} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMeetingDate(value: string | null): string | null {
  const match = value === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return real ? `${day} ${MONTHS[month - 1]} ${year}` : null;
}

export function describeMeetingCounts(document: DocumentItem): string {
  const parts: string[] = [];
  const date = formatMeetingDate(document.meetingHeldOn);
  if (date) parts.push(date);
  if (document.durationMs !== null) parts.push(formatDuration(document.durationMs));
  if (document.participants !== null) parts.push(plural(document.participants.length, 'speaker'));
  parts.push(plural(document.chunkCount, 'passage'));
  return parts.join(' · ');
}

export function describeNotesCounts(notes: MeetingNotes): string {
  return [
    plural(notes.decisions.length, 'decision'),
    plural(notes.actionItems.length, 'action item'),
  ].join(' · ');
}

export function shownSpeakers(participants: string[]): { shown: string[]; more: number } {
  return {
    shown: participants.slice(0, SPEAKERS_SHOWN),
    more: Math.max(0, participants.length - SPEAKERS_SHOWN),
  };
}

export function notesToMarkdown(document: DocumentItem, notes: MeetingNotes): string {
  const date = formatMeetingDate(document.meetingHeldOn);
  const lines = [`# ${document.filename}${date ? ` (${date})` : ''}`, ''];
  if (notes.summary) lines.push(notes.summary, '');
  if (notes.topics.length > 0) lines.push(`Topics: ${notes.topics.join('; ')}`, '');
  if (notes.decisions.length > 0) {
    lines.push('## Decisions', '');
    for (const decision of notes.decisions) {
      lines.push(`- [${formatClock(decision.startMs)}] ${decision.text}`);
    }
    lines.push('');
  }
  if (notes.actionItems.length > 0) {
    lines.push('## Action items', '');
    for (const item of notes.actionItems) {
      const owner = item.owner ?? 'no owner stated';
      const due = item.due ? `, due: ${item.due}` : '';
      lines.push(`- [ ] [${formatClock(item.startMs)}] ${item.task} (${owner}${due})`);
    }
    lines.push('');
  }
  if (notes.openQuestions.length > 0) {
    lines.push('## Open questions', '');
    for (const question of notes.openQuestions) lines.push(`- ${question}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
