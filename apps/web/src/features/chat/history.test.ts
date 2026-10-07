import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../chats/api';
import { toUIMessages } from './history';
import { sourcesOf, textOf } from './types';

const source = {
  id: 1,
  chunkId: 'k',
  documentId: 'd',
  filename: 'handbook.pdf',
  page: 4,
  ordinal: 0,
  excerpt: 'x',
  score: 0.8,
};
const retrieval = {
  query: 'q',
  rewritten: false,
  mode: 'hybrid' as const,
  bestScore: 0.8,
  outcome: 'answered' as const,
};

function stored(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    sources: [],
    retrieval: null,
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

describe('toUIMessages', () => {
  it('keeps order, ids, roles and text', () => {
    const result = toUIMessages([
      stored({ id: 'a', content: 'one' }),
      stored({ id: 'b', role: 'assistant', content: 'two' }),
    ]);

    expect(result.map((m) => [m.id, m.role, textOf(m)])).toEqual([
      ['a', 'user', 'one'],
      ['b', 'assistant', 'two'],
    ]);
  });

  it('gives an assistant message back the sources it was saved with', () => {
    const [message] = toUIMessages([
      stored({ role: 'assistant', content: 'Answer [1]', sources: [source], retrieval }),
    ]);

    expect(sourcesOf(message!)).toEqual([source]);
  });

  it('adds no source data to a user message or to an old message saved without retrieval details', () => {
    const result = toUIMessages([
      stored({ sources: [source], retrieval }),
      stored({ role: 'assistant', sources: [], retrieval: null }),
    ]);

    expect(result.every((m) => m.parts.every((p) => p.type === 'text'))).toBe(true);
  });
});
