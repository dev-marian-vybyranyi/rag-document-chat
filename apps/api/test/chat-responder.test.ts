import { describe, expect, it } from 'vitest';
import {
  CLOSEST_PASSAGES,
  EXCERPT_LENGTH,
  closestPassages,
  toTracedChunks,
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

describe('the code location in what the user sees and what is traced', () => {
  const location = {
    path: 'src/auth/routes.ts',
    language: 'typescript',
    startLine: 10,
    endLine: 24,
    symbol: 'login',
  };
  const fileChunk = {
    chunkId: 'c1',
    documentId: 'repo',
    filename: 'acme/shop',
    ordinal: 3,
    page: null,
    code: location,
    content: 'export function login() {}',
    score: 0.03,
    vectorScore: 0.71,
    vectorRank: 1,
    keywordScore: 0.2,
    keywordRank: 2,
  } as RetrievedChunk;

  it('reaches the message sources, which are stored with the answer', () => {
    const promptSource: PromptSource = {
      id: 1,
      chunkId: 'c1',
      documentId: 'repo',
      filename: 'acme/shop',
      page: null,
      code: location,
      ordinal: 3,
    };

    const [source] = toMessageSources([promptSource], [fileChunk]);

    expect(source).toMatchObject({ id: 1, code: location, excerpt: 'export function login() {}' });
  });

  it('is left out of the sources of a document passage', () => {
    const promptSource: PromptSource = {
      id: 1,
      chunkId: 'c1',
      documentId: 'doc',
      filename: 'a.txt',
      page: 2,
      ordinal: 0,
    };

    const [source] = toMessageSources([promptSource], [{ ...fileChunk, code: undefined }]);

    expect(source).not.toHaveProperty('code', location);
  });

  it('names the file in the closest passages shown when nothing was relevant', () => {
    expect(closestPassages([fileChunk])).toEqual([
      { filename: 'acme/shop', page: null, code: location, score: 0.71 },
    ]);
  });

  it('is recorded in the trace of the retrieval', () => {
    const [traced] = toTracedChunks([fileChunk], new Set(['c1']));

    expect(traced).toMatchObject({ code: location, sentToModel: true });
  });

  it('is left out of the trace of a document passage', () => {
    const [traced] = toTracedChunks([{ ...fileChunk, code: undefined }], new Set());

    expect(traced).not.toHaveProperty('code', location);
  });
});
