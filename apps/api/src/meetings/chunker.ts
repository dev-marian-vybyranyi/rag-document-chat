import { estimateTokens } from '../documents/chunker.js';
import { formatTimestamp } from './timestamp.js';
import type { Turn } from './transcript.js';

export interface MeetingChunk {
  startMs: number;
  endMs: number;
  speakers: string[];
  content: string;
  tokenCount: number;
}

export interface MeetingChunkOptions {
  title?: string;
  heldOn?: string | null;
  endMs?: number;
  maxTokens?: number;
  maxGapMs?: number;
}

export const MEETING_MAX_TOKENS = 225;
export const MEETING_MAX_GAP_MS = 120_000;

const CHARS_PER_TOKEN = 4;
const MIN_PIECE_CHARS = 40;
const OVERLAP_SHARE = 3;

interface Unit {
  speaker: string;
  startMs: number;
  endMs: number;
  line: string;
  turn: number;
}

function cutAtWords(sentence: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    let at = rest.lastIndexOf(' ', maxChars);
    if (at <= 0) {
      at = maxChars;
      const last = rest.charCodeAt(at - 1);
      if (last >= 0xd800 && last <= 0xdbff) at--;
    }
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

export function splitSpeech(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    for (const part of cutAtWords(sentence, maxChars)) {
      if (current !== '' && current.length + 1 + part.length <= maxChars) {
        current += ` ${part}`;
      } else {
        if (current !== '') pieces.push(current);
        current = part;
      }
    }
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

export function chunkTranscript(turns: Turn[], options: MeetingChunkOptions = {}): MeetingChunk[] {
  const maxChars = Math.max(1, options.maxTokens ?? MEETING_MAX_TOKENS) * CHARS_PER_TOKEN;
  const maxGapMs = options.maxGapMs ?? MEETING_MAX_GAP_MS;
  const header = headerOf(options.title, options.heldOn);
  const headerCost = header === '' ? 0 : header.length + 1;

  const units = turns.flatMap((turn, index) => {
    const text = turn.text.replace(/\s+/g, ' ').trim();
    if (text === '') return [];
    const next = turns[index + 1];
    const known = next ? next.startMs : (options.endMs ?? turn.startMs);
    const endMs = Math.max(turn.startMs, Math.min(known, turn.startMs + maxGapMs));
    const prefix = `[${formatTimestamp(turn.startMs)}] ${turn.speaker}: `;
    const room = Math.max(MIN_PIECE_CHARS, maxChars - headerCost - prefix.length);
    return splitSpeech(text, room).map((piece): Unit => ({
      speaker: turn.speaker,
      startMs: turn.startMs,
      endMs,
      line: prefix + piece,
      turn: index,
    }));
  });

  const chunks: MeetingChunk[] = [];
  let window: Unit[] = [];
  let size = headerCost;

  const emit = () => {
    if (window.length === 0) return;
    const content = [...(header === '' ? [] : [header]), ...window.map((unit) => unit.line)].join(
      '\n',
    );
    chunks.push({
      startMs: Math.min(...window.map((unit) => unit.startMs)),
      endMs: Math.max(...window.map((unit) => unit.endMs)),
      speakers: [...new Set(window.map((unit) => unit.speaker))],
      content,
      tokenCount: estimateTokens(content),
    });
  };

  for (const unit of units) {
    const previous = window.at(-1);
    const cost = unit.line.length + 1;
    const paused = previous !== undefined && Math.abs(unit.startMs - previous.startMs) > maxGapMs;
    if (previous !== undefined && (paused || size + cost > maxChars)) {
      emit();
      const carried =
        !paused && previous.line.length * OVERLAP_SHARE <= maxChars ? previous : undefined;
      window = carried && headerCost + carried.line.length + 1 + cost <= maxChars ? [carried] : [];
      size = headerCost + window.reduce((sum, item) => sum + item.line.length + 1, 0);
    }
    window.push(unit);
    size += cost;
  }
  emit();
  return chunks;
}

function headerOf(title: string | undefined, heldOn: string | null | undefined): string {
  if (!title) return '';
  return heldOn ? `Meeting: ${title} (${heldOn})` : `Meeting: ${title}`;
}
