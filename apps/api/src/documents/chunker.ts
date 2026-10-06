import type { TextSegment } from './extract.js';

export interface Chunk {
  /** Position in the document, in reading order, starting at 0. */
  ordinal: number;
  /**
   * Page where the chunk's own text starts (null for plain text). It may open with a short
   * overlap from the end of the previous page, so that a sentence cut by a page break is
   * whole in at least one chunk.
   */
  page: number | null;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Soft upper bound for a chunk's size. */
  maxTokens?: number;
  /** How much of the end of a chunk is repeated at the start of the next one. */
  overlapTokens?: number;
}

export const DEFAULT_MAX_TOKENS = 400;
export const DEFAULT_OVERLAP_TOKENS = 60;

// No tokenizer for the embedding model is available in Node, so size is estimated from the
// length: about four characters per token for English. Close enough for sizing chunks.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The smallest piece of text the packer moves around, with how it joins its predecessor. */
interface Unit {
  text: string;
  /** What goes between the previous unit and this one when they share a chunk. */
  separator: string;
  /** The Markdown section this unit sits in, e.g. "## Installation". */
  heading: string | null;
}

/**
 * Splits extracted text into overlapping, roughly equal chunks along natural boundaries:
 * paragraphs are kept whole when they fit, long ones are cut at sentence ends, and only a
 * sentence longer than a whole chunk is cut between words. Chunk size is a soft limit: a
 * Markdown section title that is prepended for context may push a chunk slightly over it.
 */
export function chunkSegments(segments: TextSegment[], options: ChunkOptions = {}): Chunk[] {
  const maxChars = Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS) * CHARS_PER_TOKEN;
  // Overlap beyond half a chunk would make chunks mostly repeat each other.
  const overlapChars = Math.min(
    Math.max(0, options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS) * CHARS_PER_TOKEN,
    Math.floor(maxChars / 2),
  );

  const chunks: Chunk[] = [];
  let carried: Unit[] = []; // the end of the previous page, repeated at the start of this one
  for (const segment of segments) {
    const units = toUnits(segment.text, maxChars);
    if (units.length === 0) continue;
    if (carried.length > 0) units[0] = joinAcrossPageBreak(carried.at(-1)!, units[0]!);

    const packed = packUnits(units, maxChars, overlapChars, carried);
    for (const content of packed.contents) {
      chunks.push({
        ordinal: chunks.length,
        page: segment.page,
        content,
        tokenCount: estimateTokens(content),
      });
    }
    carried = packed.tail;
  }
  return chunks;
}

const HEADING = /^#{1,6}\s+\S/;

function toUnits(text: string, maxChars: number): Unit[] {
  const units: Unit[] = [];
  let heading: string | null = null;

  for (const raw of text.split(/\n{2,}/)) {
    const paragraph = raw.trim();
    if (paragraph.length === 0) continue;

    const firstLine = paragraph.split('\n', 1)[0]!.trim();
    if (HEADING.test(firstLine)) heading = firstLine;

    if (paragraph.length <= maxChars) {
      units.push({ text: paragraph, separator: '\n\n', heading });
      continue;
    }

    let first = true;
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      for (const piece of fitToLength(sentence.trim(), maxChars)) {
        if (piece.text.length === 0) continue;
        units.push({ text: piece.text, separator: first ? '\n\n' : piece.separator, heading });
        first = false;
      }
    }
  }
  return units;
}

/**
 * A page break often falls in the middle of a sentence. If the last unit of the previous page
 * did not end one, the first unit of the next page continues it, so they are joined with a
 * space instead of a paragraph break.
 */
function joinAcrossPageBreak(previous: Unit, next: Unit): Unit {
  const sentenceEnded = /[.!?:]["')\]]*$/.test(previous.text);
  return sentenceEnded || HEADING.test(next.text) ? next : { ...next, separator: ' ' };
}

/** Cuts a sentence that is too long between words, or inside a word if it has no spaces. */
function fitToLength(sentence: string, maxChars: number): { text: string; separator: string }[] {
  if (sentence.length <= maxChars) return [{ text: sentence, separator: ' ' }];

  const pieces: { text: string; separator: string }[] = [];
  let current = '';
  const flush = () => {
    if (current.length > 0) pieces.push({ text: current, separator: ' ' });
    current = '';
  };

  for (const word of sentence.split(/\s+/)) {
    if (word.length > maxChars) {
      flush();
      for (let i = 0; i < word.length; i += maxChars) {
        pieces.push({ text: word.slice(i, i + maxChars), separator: i === 0 ? ' ' : '' });
      }
      continue;
    }
    if (current.length > 0 && current.length + 1 + word.length > maxChars) flush();
    current = current.length > 0 ? `${current} ${word}` : word;
  }
  flush();
  return pieces;
}

function packUnits(
  units: Unit[],
  maxChars: number,
  overlapChars: number,
  carried: Unit[],
): { contents: string[]; tail: Unit[] } {
  const contents: string[] = [];
  let current: Unit[] = carried;
  let currentLength = joinedLength(carried);
  let newUnits = 0; // units in `current` that are not just overlap carried from the last chunk

  const emit = () => {
    if (newUnits === 0) return;
    contents.push(withHeading(current));
  };

  for (const unit of units) {
    const addition = (current.length > 0 ? unit.separator.length : 0) + unit.text.length;

    if (current.length > 0 && currentLength + addition > maxChars) {
      emit();
      // Carry the tail of this chunk into the next, leaving room for the unit that did not fit.
      const room = Math.min(overlapChars, maxChars - unit.text.length - unit.separator.length);
      current = tailWithin(current, room);
      currentLength = joinedLength(current);
      newUnits = 0;
    }

    currentLength += (current.length > 0 ? unit.separator.length : 0) + unit.text.length;
    current.push(unit);
    newUnits++;
  }
  emit();
  return { contents, tail: tailWithin(current, overlapChars) };
}

function joinedLength(units: Unit[]): number {
  return units.reduce((sum, u, i) => sum + u.text.length + (i > 0 ? u.separator.length : 0), 0);
}

/** The last units whose joined length stays within `limit`. */
function tailWithin(units: Unit[], limit: number): Unit[] {
  let length = 0;
  let count = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const joinCost = count > 0 ? units[i + 1]!.separator.length : 0;
    const next = length + units[i]!.text.length + joinCost;
    if (next > limit) break;
    length = next;
    count++;
  }
  return units.slice(units.length - count);
}

/** Joins the units, naming the Markdown section at the top if the text does not already. */
function withHeading(units: Unit[]): string {
  const text = units.map((u, i) => (i === 0 ? u.text : u.separator + u.text)).join('');
  const heading = units[0]!.heading;
  return heading && !text.startsWith(heading) ? `${heading}\n\n${text}` : text;
}
