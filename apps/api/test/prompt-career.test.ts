import { describe, expect, it } from 'vitest';
import type { CareerSource } from '../src/rag/career-source.js';
import type { RetrievedChunk } from '../src/rag/fusion.js';
import { buildChatPrompt } from '../src/rag/prompt.js';

const career = (overrides: Partial<CareerSource> = {}): CareerSource => ({
  role: 'job_posting',
  section: 'requirements',
  jobNumber: 2,
  ...overrides,
});

function chunk(id: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: `chunk-${id}`,
    documentId: `doc-${id}`,
    filename: 'Platform Engineer',
    ordinal: 0,
    page: null,
    content: `text of ${id}`,
    score: 0.03,
    vectorScore: 0.7,
    vectorRank: 1,
    keywordScore: 0.1,
    keywordRank: 1,
    ...overrides,
  };
}

const build = (chunks: RetrievedChunk[]) =>
  buildChatPrompt({ question: 'What am I missing?', history: [], chunks });

describe('buildChatPrompt for resumes and job postings', () => {
  it('keeps the career location on the prompt source, so the interface can show it', () => {
    const prompt = build([
      chunk('a', { career: career() }),
      chunk('b', { career: career({ role: 'resume', section: 'skills', jobNumber: null }) }),
      chunk('c'),
    ]);

    expect(prompt.sources[0]).toMatchObject({ id: 1, career: career() });
    expect(prompt.sources[1]).toMatchObject({
      id: 2,
      career: { role: 'resume', section: 'skills', jobNumber: null },
    });
    expect(prompt.sources[2]).not.toHaveProperty('career');
  });

  it('numbers them together with other sources', () => {
    const prompt = build([chunk('a'), chunk('b', { career: career() })]);

    expect(prompt.sources.map((source) => source.id)).toEqual([1, 2]);
  });
});
