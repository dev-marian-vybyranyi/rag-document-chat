import { describe, expect, it } from 'vitest';
import {
  CLOSEST_PASSAGES,
  EXCERPT_LENGTH,
  closestPassages,
  MAX_TITLE_FROM_QUESTION,
  titleFromQuestion,
  toMessageSources,
} from '../src/chat/responder.js';
import type { RetrievedChunk } from '../src/rag/fusion.js';
import type { PromptSource } from '../src/rag/prompt.js';

describe('titleFromQuestion', () => {
  it('collapses whitespace', () => {
    expect(titleFromQuestion('  What   is\nHNSW?  ')).toBe('What is HNSW?');
  });

  it('keeps a short question as it is', () => {
    expect(titleFromQuestion('What is HNSW?')).toBe('What is HNSW?');
  });

  it('shortens a long question to the limit with an ellipsis', () => {
    const title = titleFromQuestion('word '.repeat(40));

    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_FROM_QUESTION);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
});

describe('toMessageSources', () => {
  const chunk = (chunkId: string, content: string, vectorScore?: number): RetrievedChunk =>
    ({
      chunkId,
      documentId: 'doc',
      filename: 'a.txt',
      ordinal: 0,
      page: 2,
      content,
      score: 0.03,
      vectorScore,
      vectorRank: vectorScore === undefined ? null : 2,
      keywordScore: 0.4,
      keywordRank: 5,
    }) as RetrievedChunk;

  const source = (id: number, chunkId: string): PromptSource => ({
    id,
    chunkId,
    documentId: 'doc',
    filename: 'a.txt',
    page: 2,
    ordinal: 0,
  });

  it('adds an excerpt and the cosine similarity to each source', () => {
    const result = toMessageSources([source(1, 'c1')], [chunk('c1', 'full text', 0.77)]);

    expect(result).toEqual([
      {
        ...source(1, 'c1'),
        excerpt: 'full text',
        score: 0.77,
        vectorRank: 2,
        keywordScore: 0.4,
        keywordRank: 5,
        fusedScore: 0.03,
      },
    ]);
  });

  it('cuts the excerpt', () => {
    const [first] = toMessageSources([source(1, 'c1')], [chunk('c1', 'x'.repeat(1000), 0.5)]);

    expect(first!.excerpt).toHaveLength(EXCERPT_LENGTH);
  });

  it('has no score for a chunk that only keyword search found', () => {
    const [first] = toMessageSources([source(1, 'c1')], [chunk('c1', 'text')]);

    expect(first!.score).toBeNull();
  });

  it('keeps the prompt numbering and skips sources whose chunk is missing', () => {
    const result = toMessageSources(
      [source(1, 'c1'), source(2, 'gone'), source(3, 'c3')],
      [chunk('c1', 'one', 0.7), chunk('c3', 'three', 0.6)],
    );

    expect(result.map((s) => s.id)).toEqual([1, 3]);
  });
});

describe('closestPassages', () => {
  const chunk = (filename: string, vectorScore: number | null, page: number | null = 1) =>
    ({ filename, page, vectorScore }) as RetrievedChunk;

  it('lists the best matches first, with where they are from', () => {
    const result = closestPassages([
      chunk('a.txt', 0.5),
      chunk('b.pdf', 0.62, 7),
      chunk('c.txt', 0.4),
    ]);

    expect(result).toEqual([
      { filename: 'b.pdf', page: 7, score: 0.62 },
      { filename: 'a.txt', page: 1, score: 0.5 },
      { filename: 'c.txt', page: 1, score: 0.4 },
    ]);
  });

  it('keeps only the top few', () => {
    const many = Array.from({ length: 8 }, (_, i) => chunk(`f${i}.txt`, i / 10));

    expect(closestPassages(many)).toHaveLength(CLOSEST_PASSAGES);
    expect(closestPassages(many)[0]!.filename).toBe('f7.txt');
  });

  it('skips passages that only keyword search found, which have no similarity', () => {
    expect(closestPassages([chunk('a.txt', null), chunk('b.txt', 0.3)])).toEqual([
      { filename: 'b.txt', page: 1, score: 0.3 },
    ]);
    expect(closestPassages([])).toEqual([]);
  });
});
