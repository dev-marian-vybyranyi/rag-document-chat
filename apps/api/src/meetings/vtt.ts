import { stripInvisibleCharacters } from '../rag/sanitize.js';
import { cleanSpeakerName, createSpeakerRegistry, NAME_SOURCE } from './speakers.js';
import { parseTimestamp } from './timestamp.js';
import { TranscriptParseError, type ParsedTranscript, type Turn } from './transcript.js';

const CUE_TIMING = /^(\S+)\s+-->\s+(\S+)/;
const VOICE_TAG = /^<v(?:\.[^\s>]*)?\s+([^>]{1,200})>/;
const NAME_PREFIX = new RegExp(String.raw`^(${NAME_SOURCE}):\s*(.+)$`);
const SKIPPED_BLOCK = /^(?:NOTE|STYLE|REGION)(?:\s|$)/;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&nbsp;': ' ',
};

const decodeEntities = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|nbsp);/g, (m) => ENTITIES[m]!);

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export const isWebVtt = (text: string) => /^WEBVTT(?:\s|$)/.test(text);

interface Cue {
  line: number;
  startMs: number;
  endMs: number;
  payload: string;
}

function readCues(lines: string[]): Cue[] {
  const cues: Cue[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.trim() !== '') index++;

  while (index < lines.length) {
    while (index < lines.length && lines[index]!.trim() === '') index++;
    if (index >= lines.length) break;

    const blockStart = index;
    const block: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== '') block.push(lines[index++]!);
    if (SKIPPED_BLOCK.test(block[0]!)) continue;

    const timingAt = block.findIndex((line) => CUE_TIMING.test(line.trim()));
    if (timingAt < 0 || timingAt > 1) {
      throw new TranscriptParseError(
        'expected a cue with a time range ("00:00:01.000 --> 00:00:04.000")',
        blockStart + 1,
      );
    }
    const [, from, to] = CUE_TIMING.exec(block[timingAt]!.trim())!;
    const startMs = parseTimestamp(from!);
    const endMs = parseTimestamp(to!);
    if (startMs === null || endMs === null) {
      throw new TranscriptParseError(
        'the cue time is not a valid timestamp',
        blockStart + timingAt + 1,
      );
    }
    cues.push({
      line: blockStart + timingAt + 1,
      startMs,
      endMs,
      payload: block.slice(timingAt + 1).join('\n'),
    });
  }
  return cues;
}

function speakerAndText(payload: string): { speaker: string | null; text: string } {
  const voice = VOICE_TAG.exec(payload);
  const spoken = voice ? payload.slice(voice[0].length) : payload;
  const text = collapse(decodeEntities(spoken.replace(/<[^>]*>/g, '')));
  if (voice) return { speaker: cleanSpeakerName(decodeEntities(voice[1]!)), text };

  const prefixed = NAME_PREFIX.exec(text);
  const speaker = prefixed ? cleanSpeakerName(prefixed[1]!) : null;
  return speaker ? { speaker, text: prefixed![2]!.trim() } : { speaker: null, text };
}

export function parseWebVtt(raw: string): ParsedTranscript {
  const lines = stripInvisibleCharacters(raw).replace(/\r\n?/g, '\n').split('\n');
  const registry = createSpeakerRegistry();
  const turns: Turn[] = [];
  let lastEnd = 0;
  let outOfOrderTurns = 0;
  let previousSpeaker: string | null = null;

  for (const cue of readCues(lines)) {
    const { speaker: label, text } = speakerAndText(cue.payload);
    const speaker = label ?? previousSpeaker;
    if (speaker === null) {
      throw new TranscriptParseError(
        'the cue has no speaker (use "<v Name>" or "Name: text")',
        cue.line,
      );
    }
    if (text === '') continue;

    const canonical = registry.canonical(speaker);
    previousSpeaker = canonical;
    if (turns.length > 0 && cue.startMs < turns.at(-1)!.startMs) outOfOrderTurns++;
    turns.push({ speaker: canonical, startMs: cue.startMs, text });
    lastEnd = Math.max(lastEnd, cue.endMs, cue.startMs);
  }

  if (turns.length < 2) {
    throw new TranscriptParseError(
      'the file has fewer than two spoken cues with a speaker and a time',
    );
  }
  return {
    turns,
    participants: registry.names(),
    durationMs: lastEnd - turns[0]!.startMs,
    outOfOrderTurns,
  };
}
