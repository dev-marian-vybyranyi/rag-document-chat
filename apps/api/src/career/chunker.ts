import { estimateTokens } from '../documents/chunker.js';
import { splitSpeech } from '../meetings/chunker.js';
import { cleanLabel, sectionLabel } from './labels.js';
import type { TextSection } from './sections.js';
import type { CareerSection } from './types.js';

export interface CareerChunk {
  ordinal: number;
  page: number | null;
  section: CareerSection;
  content: string;
  tokenCount: number;
}

export interface CareerChunkOptions {
  label: string;
  maxChars?: number;
}

export const CAREER_MAX_CHARS = 900;

const MIN_BODY_CHARS = 40;

function contextLine(label: string, section: TextSection): string {
  return [cleanLabel(label), sectionLabel(section.section, section.heading), section.title]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

function packLines(text: string, limit: number): string[] {
  const lines = text.split('\n').flatMap((line) => {
    const trimmed = line.trimEnd();
    return trimmed.length > limit ? splitSpeech(trimmed, limit) : [trimmed];
  });

  const bodies: string[] = [];
  let current = '';
  const flush = () => {
    const body = current.trim();
    if (body !== '') bodies.push(body);
    current = '';
  };
  for (const line of lines) {
    if (current !== '' && current.length + 1 + line.length > limit) flush();
    current = current === '' ? line : `${current}\n${line}`;
  }
  flush();
  return bodies;
}

export function chunkSections(
  sections: TextSection[],
  { label, maxChars = CAREER_MAX_CHARS }: CareerChunkOptions,
): CareerChunk[] {
  const chunks: CareerChunk[] = [];
  for (const section of sections) {
    const header = contextLine(label, section);
    const limit = Math.max(MIN_BODY_CHARS, maxChars - header.length - 1);
    for (const body of packLines(section.text, limit)) {
      const content = `${header}\n${body}`;
      chunks.push({
        ordinal: chunks.length,
        page: section.page,
        section: section.section,
        content,
        tokenCount: estimateTokens(content),
      });
    }
  }
  return chunks;
}
