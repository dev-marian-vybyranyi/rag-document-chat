import { describe, expect, it } from 'vitest';
import {
  chunkSegments,
  DEFAULT_MAX_TOKENS,
  estimateTokens,
  type Chunk,
} from '../src/documents/chunker.js';
import type { TextSegment } from '../src/documents/extract.js';

const CHARS_PER_TOKEN = 4;

/** `count` distinct sentences of roughly 50 characters each: "Sentence number 07 says something." */
function sentences(count: number, prefix = 'Sentence'): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${prefix} number ${String(i).padStart(2, '0')} says something useful.`,
  );
}

const unpaged = (text: string): TextSegment[] => [{ page: null, text }];

/** Small chunks make behaviour visible with short test strings. */
// 200 characters per chunk; the 80-character overlap fits exactly one 41-character test sentence.
const small = { maxTokens: 50, overlapTokens: 20 };

describe('chunkSegments', () => {
  describe('basics', () => {
    it('returns nothing for no text', () => {
      expect(chunkSegments([])).toEqual([]);
      expect(chunkSegments(unpaged('   \n\n  '))).toEqual([]);
    });

    it('keeps short text in a single chunk, with its page and size', () => {
      const chunks = chunkSegments([{ page: 3, text: 'A short note about vectors.' }]);

      expect(chunks).toEqual([
        { ordinal: 0, page: 3, content: 'A short note about vectors.', tokenCount: 7 },
      ]);
    });

    it('reports the estimated size of every chunk', () => {
      const chunks = chunkSegments(unpaged(sentences(20).join(' ')), small);

      for (const chunk of chunks) expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
    });

    it('numbers chunks 0, 1, 2… across the whole document', () => {
      const segments = [
        { page: 1, text: sentences(10).join(' ') },
        { page: 2, text: sentences(10, 'Other').join(' ') },
      ];

      const chunks = chunkSegments(segments, small);

      expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
      expect(chunks.length).toBeGreaterThan(2);
    });

    it('uses a sensible default chunk size', () => {
      const chunks = chunkSegments(unpaged(sentences(200).join(' ')));

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
    });
  });

  describe('sizing', () => {
    it('keeps every chunk within the size limit', () => {
      const chunks = chunkSegments(unpaged(sentences(40).join(' ')), small);

      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(small.maxTokens * CHARS_PER_TOKEN);
      }
    });

    it('packs paragraphs together up to the limit and never splits one that fits', () => {
      const paragraphs = Array.from(
        { length: 6 },
        (_, i) => `Paragraph ${i}: ${'word '.repeat(12).trim()}.`,
      );

      const chunks = chunkSegments(unpaged(paragraphs.join('\n\n')), {
        maxTokens: 50,
        overlapTokens: 0,
      });

      expect(chunks.length).toBeGreaterThan(1);
      for (const paragraph of paragraphs) {
        expect(chunks.filter((c) => c.content.includes(paragraph))).toHaveLength(1);
      }
    });

    it('cuts an over-long paragraph at sentence ends', () => {
      const chunks = chunkSegments(unpaged(sentences(30).join(' ')), {
        maxTokens: 50,
        overlapTokens: 0,
      });

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.content).toMatch(/useful\.$/);
      for (const chunk of chunks) expect(chunk.content).toMatch(/^Sentence number/);
    });

    it('cuts a sentence longer than a chunk between words, never inside one', () => {
      const words = Array.from({ length: 120 }, (_, i) => `word${i}`);

      const chunks = chunkSegments(unpaged(words.join(' ')), { maxTokens: 50, overlapTokens: 0 });

      expect(chunks.length).toBeGreaterThan(1);
      const seen = chunks.flatMap((c) => c.content.split(' '));
      expect(seen).toEqual(words);
    });

    it('still makes progress on text without any spaces', () => {
      const blob = 'x'.repeat(1000);

      const chunks = chunkSegments(unpaged(blob), { maxTokens: 50, overlapTokens: 0 });

      expect(chunks.map((c) => c.content.length)).toEqual([200, 200, 200, 200, 200]);
      expect(chunks.map((c) => c.content).join('')).toBe(blob);
    });
  });

  describe('overlap', () => {
    it('repeats the end of a chunk at the start of the next', () => {
      const chunks = chunkSegments(unpaged(sentences(30).join(' ')), small);

      for (let i = 1; i < chunks.length; i++) {
        const previousLastSentence = chunks[i - 1]!.content.split(/(?<=\.)\s+/).at(-1)!;
        expect(chunks[i]!.content.startsWith(previousLastSentence)).toBe(true);
      }
    });

    it('stays within the configured amount', () => {
      const chunks = chunkSegments(unpaged(sentences(30).join(' ')), small);

      for (let i = 1; i < chunks.length; i++) {
        const sharedSentences = chunks[i]!.content.split(/(?<=\.)\s+/).filter((s) =>
          chunks[i - 1]!.content.includes(s),
        );
        const sharedLength = sharedSentences.join(' ').length;
        expect(sharedLength).toBeLessThanOrEqual(small.overlapTokens * CHARS_PER_TOKEN);
      }
    });

    it('can be switched off', () => {
      const chunks = chunkSegments(unpaged(sentences(30).join(' ')), {
        maxTokens: 50,
        overlapTokens: 0,
      });

      const all = chunks.map((c) => c.content).join(' ');
      expect(all.split(' ').length).toBe(sentences(30).join(' ').split(' ').length);
    });

    it('never grows a chunk past the limit, even with a huge overlap setting', () => {
      const chunks = chunkSegments(unpaged(sentences(30).join(' ')), {
        maxTokens: 50,
        overlapTokens: 5000,
      });

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(200);
    });

    it('does not repeat whole paragraphs that are bigger than the overlap', () => {
      const paragraphs = Array.from({ length: 4 }, (_, i) => `P${i} ${'w '.repeat(70).trim()}.`);

      const chunks = chunkSegments(unpaged(paragraphs.join('\n\n')), small);

      for (const paragraph of paragraphs) {
        expect(chunks.filter((c) => c.content.includes(paragraph))).toHaveLength(1);
      }
    });

    it('does not create a trailing chunk made only of overlap', () => {
      const chunks = chunkSegments(unpaged(sentences(12).join(' ')), small);

      const last = chunks.at(-1)!;
      const previous = chunks.at(-2)!;
      expect(last.content).not.toBe(previous.content);
      expect(last.content).toContain('number 11');
    });
  });

  describe('completeness', () => {
    it('loses no sentence', () => {
      const all = sentences(60);

      const chunks = chunkSegments(unpaged(all.join(' ')), small);

      for (const sentence of all) {
        expect(chunks.some((c) => c.content.includes(sentence))).toBe(true);
      }
    });

    it('loses no paragraph', () => {
      const paragraphs = Array.from(
        { length: 25 },
        (_, i) => `Topic ${i}: ${sentences(2).join(' ')}`,
      );

      const chunks = chunkSegments(unpaged(paragraphs.join('\n\n')), small);

      for (const paragraph of paragraphs) {
        expect(chunks.some((c) => c.content.includes(paragraph))).toBe(true);
      }
    });
  });

  describe('pages', () => {
    it('attributes each chunk to the page where its own text starts', () => {
      const segments: TextSegment[] = [
        { page: 1, text: 'Alpha sentence on the first page.' },
        { page: 2, text: 'Beta sentence on the second page.' },
      ];

      const chunks = chunkSegments(segments, { maxTokens: 50, overlapTokens: 0 });

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({ page: 1, content: 'Alpha sentence on the first page.' });
      expect(chunks[1]).toMatchObject({ page: 2, content: 'Beta sentence on the second page.' });
    });

    it('never puts text of a later page into the chunk of an earlier one', () => {
      const segments: TextSegment[] = [
        { page: 1, text: sentences(10).join(' ') },
        { page: 2, text: sentences(10, 'Later').join(' ') },
      ];

      const chunks = chunkSegments(segments, small);

      for (const chunk of chunks.filter((c) => c.page === 1)) {
        expect(chunk.content).not.toContain('Later number');
      }
    });

    it('keeps the page number on every chunk of a long page', () => {
      const chunks = chunkSegments([{ page: 7, text: sentences(40).join(' ') }], small);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.page === 7)).toBe(true);
    });

    it('repeats the end of a page at the start of the next, like any other overlap', () => {
      const segments: TextSegment[] = [
        { page: 1, text: sentences(10).join(' ') },
        { page: 2, text: sentences(10, 'Later').join(' ') },
      ];

      const chunks = chunkSegments(segments, small);

      const firstOnPageTwo = chunks.find((c) => c.page === 2)!;
      expect(firstOnPageTwo.content.startsWith('Sentence number 09 says something useful.')).toBe(
        true,
      );
      expect(firstOnPageTwo.content).toContain('Later number 00');
    });

    it('does not repeat anything across the page break when overlap is off', () => {
      const segments: TextSegment[] = [
        { page: 1, text: sentences(10).join(' ') },
        { page: 2, text: sentences(10, 'Later').join(' ') },
      ];

      const chunks = chunkSegments(segments, { maxTokens: 50, overlapTokens: 0 });

      const firstOnPageTwo = chunks.find((c) => c.page === 2)!;
      expect(firstOnPageTwo.content).not.toContain('Sentence number');
    });

    it('makes a sentence that a page break cut in two whole again in the next chunk', () => {
      const segments: TextSegment[] = [
        { page: 1, text: 'The first point is settled. The second point was cut' },
        { page: 2, text: 'in the middle by a page break. A third point follows.' },
      ];

      const chunks = chunkSegments(segments, small);

      expect(chunks[1]!.page).toBe(2);
      expect(chunks[1]!.content).toContain(
        'The second point was cut in the middle by a page break.',
      );
    });

    it('keeps a new Markdown section apart from the text before the page break', () => {
      const segments: TextSegment[] = [
        { page: 1, text: 'Closing words without a full stop' },
        { page: 2, text: '## Next section\n\nFresh start.' },
      ];

      const chunks = chunkSegments(segments, small);

      expect(chunks[1]!.content).toContain('Closing words without a full stop\n\n## Next section');
    });
  });

  describe('Markdown sections', () => {
    const section = (title: string, count: number) =>
      `## ${title}\n\n${sentences(count, title).join(' ')}`;

    it('names the section a chunk belongs to when it does not start with the title', () => {
      const chunks = chunkSegments(unpaged(section('Installation', 30)), small);

      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) expect(chunk.content.startsWith('## Installation')).toBe(true);
    });

    it('does not repeat the title in the chunk that already starts with it', () => {
      const chunks = chunkSegments(unpaged(section('Installation', 30)), small);

      expect(chunks[0]!.content.match(/## Installation/g)).toHaveLength(1);
    });

    it('switches to the next section title when a new section begins', () => {
      const markdown = `${section('Setup', 12)}\n\n${section('Usage', 12)}`;

      const chunks = chunkSegments(unpaged(markdown), small);

      const usageChunks = chunks.filter((c) => c.content.includes('Usage number'));
      expect(usageChunks.length).toBeGreaterThan(1);
      expect(usageChunks.at(-1)!.content.startsWith('## Usage')).toBe(true);
    });

    it('adds no title to text that has no headings', () => {
      const chunks = chunkSegments(unpaged(sentences(30).join(' ')), small);

      expect(chunks.every((c) => !c.content.includes('##'))).toBe(true);
    });

    it('stays near the size limit even with a title added', () => {
      const chunks = chunkSegments(unpaged(section('Installation', 40)), small);

      const titleAllowance = '## Installation\n\n'.length;
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(200 + titleAllowance);
      }
    });
  });

  it('gives the same result when run twice', () => {
    const text = sentences(50).join(' ');

    const first: Chunk[] = chunkSegments(unpaged(text), small);
    const second: Chunk[] = chunkSegments(unpaged(text), small);

    expect(second).toEqual(first);
  });
});
