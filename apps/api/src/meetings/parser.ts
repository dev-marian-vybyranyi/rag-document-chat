import { stripInvisibleCharacters } from '../rag/sanitize.js';
import { cleanSpeakerName, createSpeakerRegistry, NAME_SOURCE } from './speakers.js';
import { parseTimestamp, TIMESTAMP_SOURCE } from './timestamp.js';
import { TranscriptParseError, type ParsedTranscript, type Turn } from './transcript.js';
import { isWebVtt, parseWebVtt } from './vtt.js';

const MIN_TURNS = 2;
const MAX_PREAMBLE_LINES = 20;
const MIN_TURN_START_SHARE = 0.05;

interface TurnStart {
  speaker: string;
  startMs: number;
  text: string;
}

interface Matcher {
  name: string;
  match(line: string): TurnStart | null;
}

const TS = `(${TIMESTAMP_SOURCE})`;
const NAME = `(${NAME_SOURCE})`;

function matcher(
  name: string,
  source: string,
  pick: (groups: string[]) => { speaker: string; time: string; text: string },
  header: boolean,
): Matcher {
  const pattern = new RegExp(source);
  return {
    name,
    match(line) {
      const found = pattern.exec(line);
      if (!found) return null;
      const { speaker, time, text } = pick(found.slice(1).map((group) => group ?? ''));
      const startMs = parseTimestamp(time);
      const cleaned = cleanSpeakerName(speaker, { header });
      return startMs === null || cleaned === null
        ? null
        : { speaker: cleaned, startMs, text: text.trim() };
    },
  };
}

const MATCHERS: Matcher[] = [
  matcher(
    'bracket-inline',
    `^\\[${TS}\\]\\s*${NAME}\\s*:\\s*(.+)$`,
    (g) => ({ time: g[0]!, speaker: g[1]!, text: g[2]! }),
    false,
  ),
  matcher(
    'suffix-inline',
    `^${NAME}\\s*[\\[(]${TS}[\\])]\\s*:\\s*(.+)$`,
    (g) => ({ speaker: g[0]!, time: g[1]!, text: g[2]! }),
    false,
  ),
  matcher(
    'prefix-inline',
    `^${TS}\\s*[-–—]?\\s*${NAME}\\s*:\\s*(.+)$`,
    (g) => ({ time: g[0]!, speaker: g[1]!, text: g[2]! }),
    false,
  ),
  matcher(
    'bracket-header',
    `^\\[${TS}\\]\\s*${NAME}\\s*:?$`,
    (g) => ({ time: g[0]!, speaker: g[1]!, text: '' }),
    true,
  ),
  matcher(
    'suffix-header',
    `^${NAME}\\s*(?:[\\[(]${TS}[\\])]|\\s${TS})\\s*:?$`,
    (g) => ({ speaker: g[0]!, time: g[1] || g[2]!, text: '' }),
    true,
  ),
  matcher(
    'prefix-header',
    `^${TS}\\s*[-–—]?\\s*${NAME}$`,
    (g) => ({ time: g[0]!, speaker: g[1]!, text: '' }),
    true,
  ),
  matcher(
    'name-bracket-header',
    `^\\[${NAME}\\]\\s*${TS}\\s*:?$`,
    (g) => ({ speaker: g[0]!, time: g[1]!, text: '' }),
    true,
  ),
];

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

function dominantMatcher(lines: string[]): Matcher | null {
  const counts = new Map<Matcher, number>();
  for (const line of lines) {
    for (const candidate of MATCHERS) {
      if (candidate.match(line)) {
        counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
        break;
      }
    }
  }
  let best: Matcher | null = null;
  for (const candidate of MATCHERS) {
    const count = counts.get(candidate) ?? 0;
    if (count > (best ? (counts.get(best) ?? 0) : 0)) best = candidate;
  }
  return best;
}

export function parseTranscript(raw: string): ParsedTranscript {
  const text = stripInvisibleCharacters(raw).replace(/\r\n?/g, '\n');
  if (isWebVtt(text)) return parseWebVtt(text);

  const numbered = text
    .split('\n')
    .map((content, index) => ({ line: index + 1, content: collapse(content) }))
    .filter((entry) => entry.content !== '');
  if (numbered.length === 0) throw new TranscriptParseError('the file contains no text');

  const chosen = dominantMatcher(numbered.map((entry) => entry.content));
  if (!chosen) {
    throw new TranscriptParseError(
      'no line starts with a speaker and a time (for example "[00:01:05] Alice: Hello")',
      numbered[0]!.line,
    );
  }

  const registry = createSpeakerRegistry();
  const open: { speaker: string; startMs: number; parts: string[] }[] = [];
  let starts = 0;
  let preamble = 0;

  for (const { line, content } of numbered) {
    const start = chosen.match(content);
    if (start) {
      starts++;
      open.push({
        speaker: registry.canonical(start.speaker),
        startMs: start.startMs,
        parts: start.text ? [start.text] : [],
      });
    } else if (open.length > 0) {
      open.at(-1)!.parts.push(content);
    } else if (++preamble > MAX_PREAMBLE_LINES) {
      throw new TranscriptParseError('expected a speaker and a time before this text', line);
    }
  }

  const turns: Turn[] = open
    .map((turn) => ({ speaker: turn.speaker, startMs: turn.startMs, text: turn.parts.join(' ') }))
    .filter((turn) => turn.text !== '');

  if (turns.length < MIN_TURNS) {
    throw new TranscriptParseError(
      'the file has fewer than two turns with a speaker, a time and text',
    );
  }
  if (starts / numbered.length < MIN_TURN_START_SHARE) {
    throw new TranscriptParseError(
      `this does not look like a transcript: only ${starts} of ${numbered.length} lines start with a speaker and a time`,
    );
  }

  let outOfOrderTurns = 0;
  for (let i = 1; i < turns.length; i++)
    if (turns[i]!.startMs < turns[i - 1]!.startMs) outOfOrderTurns++;
  const lastMs = Math.max(...turns.map((turn) => turn.startMs));

  return {
    turns,
    participants: participantsOf(turns),
    durationMs: lastMs - turns[0]!.startMs,
    outOfOrderTurns,
  };
}

function participantsOf(turns: Turn[]): string[] {
  const seen = new Set<string>();
  for (const turn of turns) seen.add(turn.speaker);
  return [...seen];
}
