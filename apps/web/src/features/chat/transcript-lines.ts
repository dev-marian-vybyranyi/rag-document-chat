import type { Passage } from '../documents/api';

export interface SpokenLine {
  time: string;
  speaker: string;
  text: string;
}

export interface TranscriptRow extends SpokenLine {
  cited: boolean;
}

const SPEECH_LINE = /^\[(\d+:\d\d:\d\d)\] ([^:]+): (.*)$/;

export function spokenLines(content: string): SpokenLine[] {
  return content.split('\n').flatMap((row) => {
    const match = SPEECH_LINE.exec(row);
    return match ? [{ time: match[1]!, speaker: match[2]!, text: match[3]! }] : [];
  });
}

const sameLine = (a: SpokenLine, b: SpokenLine) =>
  a.time === b.time && a.speaker === b.speaker && a.text === b.text;

export function transcriptRows(
  passages: Pick<Passage, 'ordinal' | 'content'>[],
  citedOrdinal: number,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const passage of passages) {
    const cited = passage.ordinal === citedOrdinal;
    const lines = spokenLines(passage.content);
    const last = rows.at(-1);
    if (last && lines[0] && sameLine(last, lines[0])) {
      if (cited) last.cited = true;
      lines.shift();
    }
    for (const line of lines) rows.push({ ...line, cited });
  }
  return rows;
}

const TONES = [
  'text-sky-700 dark:text-sky-300',
  'text-emerald-700 dark:text-emerald-300',
  'text-violet-700 dark:text-violet-300',
  'text-rose-700 dark:text-rose-300',
  'text-teal-700 dark:text-teal-300',
  'text-fuchsia-700 dark:text-fuchsia-300',
  'text-orange-700 dark:text-orange-300',
  'text-indigo-700 dark:text-indigo-300',
];

export function speakerTone(name: string): string {
  let hash = 0;
  for (const char of name.toLocaleLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return TONES[hash % TONES.length]!;
}
