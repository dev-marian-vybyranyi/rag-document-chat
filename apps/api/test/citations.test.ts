import { describe, expect, it } from 'vitest';
import type { TextStreamPart, ToolSet } from 'ai';
import {
  createCitationFilter,
  createCitationStream,
  filterCitations,
} from '../src/chat/citations.js';

const upTo = (count: number) => (id: number) => id >= 1 && id <= count;

describe('filterCitations', () => {
  describe('references to sources that exist', () => {
    it.each([
      'It is a graph index [1].',
      'Both agree [1][2].',
      'Both agree [1, 2].',
      'No citations at all.',
      '',
    ])('are left exactly as written: %j', (text) => {
      expect(filterCitations(text, upTo(3))).toBe(text);
    });
  });

  describe('references to sources that do not exist', () => {
    it.each([
      ['It is a graph index [7].', 'It is a graph index.'],
      ['It is a graph index [0].', 'It is a graph index.'],
      ['First [1] and second [9] claims.', 'First [1] and second claims.'],
      ['Claim [8][9] here', 'Claim here'],
      ['Claim [99]\nNext line', 'Claim\nNext line'],
      ['Claim [4], then more', 'Claim, then more'],
    ])('are removed together with the space before them: %j', (text, expected) => {
      expect(filterCitations(text, upTo(3))).toBe(expected);
    });

    it('keeps the valid numbers of a list and drops the others', () => {
      expect(filterCitations('Claim [1, 9, 3].', upTo(3))).toBe('Claim [1, 3].');
      expect(filterCitations('Claim [9, 1].', upTo(3))).toBe('Claim [1].');
    });

    it('are all removed when there are no sources at all', () => {
      expect(filterCitations('One [1] two [2].', upTo(0))).toBe('One two.');
    });

    it('count what was kept and what was removed', () => {
      const filter = createCitationFilter(upTo(2));

      filter.push('A [1] B [5] C [2, 6, 7] D [3].');
      filter.flush();

      expect(filter.stats).toEqual({ kept: 2, removed: 4 });
    });
  });

  describe('text that only looks like a citation', () => {
    it.each([
      'Use items[0] and grid[3][4] in the loop.',
      'A citation glued to a word, claim[4], is taken for an index.',
      'The result (see docs)[9] stays.',
      'A link [the 2024 report](https://example.com) stays.',
      'Ranges like [1-9] stay as written.',
      'Keep [a], [x1], and [] too.',
      'A long [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] list is not a citation.',
      'Unfinished [9',
    ])('is not touched: %j', (text) => {
      expect(filterCitations(text, upTo(3))).toBe(text);
    });

    it('is not touched inside inline code', () => {
      const text = 'Index with `values[0]` or ` [9] `, then see [9].';

      expect(filterCitations(text, upTo(3))).toBe('Index with `values[0]` or ` [9] `, then see.');
    });

    it('is not touched inside a code block, and the text after it is checked again', () => {
      const text = 'Example:\n```js\nconst a = [9];\nconst b = [1];\n```\nDone [9].';

      expect(filterCitations(text, upTo(3))).toBe(
        'Example:\n```js\nconst a = [9];\nconst b = [1];\n```\nDone.',
      );
    });

    it('ends an unclosed inline code span at the end of the line', () => {
      expect(filterCitations('An odd ` tick\nthen [9] here', upTo(3))).toBe(
        'An odd ` tick\nthen here',
      );
    });
  });

  describe('when the text arrives in small pieces', () => {
    const pieces = (text: string, size: number) =>
      Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
        text.slice(i * size, (i + 1) * size),
      );

    const streamed = (text: string, size: number, isSource: (id: number) => boolean) => {
      const filter = createCitationFilter(isSource);
      return (
        pieces(text, size)
          .map((piece) => filter.push(piece))
          .join('') + filter.flush()
      );
    };

    const sample =
      'Intro [1] and [9] claim.\n```js\nlet a = [9];\n```\nUse `x[0]` then [2][8] and [1, 7] end [4]';

    it.each([1, 2, 3, 5, 8, 1000])('gives the same result with pieces of %i characters', (size) => {
      expect(streamed(sample, size, upTo(3))).toBe(filterCitations(sample, upTo(3)));
    });

    it('holds a possible citation back until it is complete', () => {
      const filter = createCitationFilter(upTo(3));

      expect(filter.push('Claim [')).toBe('Claim');
      expect(filter.push('9')).toBe('');
      expect(filter.push('] more')).toBe(' more');
    });

    it('releases a held bracket at the end of the text', () => {
      const filter = createCitationFilter(upTo(3));

      expect(filter.push('Open [1')).toBe('Open');
      expect(filter.flush()).toBe(' [1');
    });
  });
});

describe('createCitationStream', () => {
  type Part = TextStreamPart<ToolSet>;

  async function run(parts: Part[], isSource: (id: number) => boolean) {
    const { transform, stats } = createCitationStream(isSource);
    const source = new ReadableStream<Part>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const out: Part[] = [];
    await source.pipeThrough(transform).pipeTo(
      new WritableStream<Part>({
        write(part) {
          out.push(part);
        },
      }),
    );
    return { out, stats };
  }

  const delta = (text: string): Part => ({ type: 'text-delta', id: 't', text });
  const textOf = (parts: Part[]) =>
    parts.flatMap((part) => (part.type === 'text-delta' ? [part.text] : [])).join('');

  it('filters the text and passes every other part through untouched', async () => {
    const finish = { type: 'finish-step' } as unknown as Part;
    const parts: Part[] = [
      { type: 'text-start', id: 't' },
      delta('Yes [1] and [5].'),
      { type: 'text-end', id: 't' },
      finish,
    ];

    const { out, stats } = await run(parts, upTo(2));

    expect(textOf(out)).toBe('Yes [1] and.');
    expect(out.map((part) => part.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
    ]);
    expect(stats).toEqual({ kept: 1, removed: 1 });
  });

  it('releases whatever was held back before the text ends', async () => {
    const { out } = await run(
      [{ type: 'text-start', id: 't' }, delta('Open [1'), { type: 'text-end', id: 't' }],
      upTo(2),
    );

    expect(textOf(out)).toBe('Open [1');
    expect(out.at(-1)!.type).toBe('text-end');
  });

  it('never sends an empty piece of text', async () => {
    const { out } = await run([delta('['), delta('9'), delta(']')], upTo(2));

    expect(out).toEqual([]);
  });
});
