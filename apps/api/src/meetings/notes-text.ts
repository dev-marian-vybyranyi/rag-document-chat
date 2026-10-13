import { formatTimestamp } from './timestamp.js';
import type { MeetingNotes } from './types.js';

export const NOTES_PASSAGE_MAX_CHARS = 3000;

export interface NotesContext {
  title: string;
  heldOn?: string | null;
  participants: string[];
}

interface Entry {
  heading: string | null;
  line: string;
}

function entriesOf(notes: MeetingNotes, participants: string[]): Entry[] {
  const entries: Entry[] = [];
  if (participants.length > 0) {
    entries.push({ heading: null, line: `Participants: ${participants.join(', ')}` });
  }
  if (notes.summary !== '') entries.push({ heading: null, line: `Summary: ${notes.summary}` });
  if (notes.topics.length > 0) {
    entries.push({ heading: null, line: `Topics: ${notes.topics.join('; ')}` });
  }
  for (const decision of notes.decisions) {
    entries.push({
      heading: 'Decisions:',
      line: `- [${formatTimestamp(decision.startMs)}] ${decision.text}`,
    });
  }
  for (const item of notes.actionItems) {
    const owner = item.owner === null ? 'no owner stated' : `owner: ${item.owner}`;
    const due = item.due === null ? '' : `, due: ${item.due}`;
    entries.push({
      heading: 'Action items:',
      line: `- [${formatTimestamp(item.startMs)}] ${item.task} (${owner}${due})`,
    });
  }
  for (const question of notes.openQuestions) {
    entries.push({ heading: 'Open questions:', line: `- ${question}` });
  }
  return entries;
}

export function notesPassages(
  notes: MeetingNotes,
  { title, heldOn, participants }: NotesContext,
  maxChars = NOTES_PASSAGE_MAX_CHARS,
): string[] {
  const entries = entriesOf(notes, participants);
  if (!entries.some((entry) => entry.line.startsWith('Summary') || entry.heading !== null)) {
    return [];
  }

  const header = `Meeting notes: ${title}${heldOn ? ` (${heldOn})` : ''}`;
  const passages: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let heading: string | null = null;

  const start = (first: Entry) => {
    heading = first.heading;
    lines = first.heading === null ? [header] : [header, first.heading];
    size = lines.join('\n').length;
  };

  for (const entry of entries) {
    if (lines.length === 0) start(entry);
    else if (size + entry.line.length + 1 > maxChars) {
      passages.push(lines.join('\n'));
      start(entry);
    } else if (entry.heading !== heading) {
      if (entry.heading !== null) lines.push(entry.heading);
      heading = entry.heading;
      size += (entry.heading?.length ?? 0) + 1;
    }
    lines.push(entry.line);
    size += entry.line.length + 1;
  }
  passages.push(lines.join('\n'));
  return passages;
}
