import { parseTimestamp } from './timestamp.js';
import type { Turn } from './transcript.js';

const SPEECH_LINE = /^\[(\d+:\d\d:\d\d)\] ([^:]+): (.*)$/;

export function turnsFromPassages(passages: string[]): Turn[] {
  const lines: string[] = [];
  for (const passage of passages) {
    const rows = passage.split('\n').filter((row) => SPEECH_LINE.test(row));
    if (rows.length > 0 && rows[0] === lines.at(-1)) rows.shift();
    lines.push(...rows);
  }

  const turns: Turn[] = [];
  let previousKey = '';
  for (const line of lines) {
    const [, time, speaker, text] = SPEECH_LINE.exec(line)!;
    const startMs = parseTimestamp(time!);
    if (startMs === null) continue;
    const key = `${time}|${speaker}`;
    const last = turns.at(-1);
    if (last && key === previousKey) last.text += ` ${text}`;
    else turns.push({ speaker: speaker!, startMs, text: text! });
    previousKey = key;
  }
  return turns;
}
