import { describe, expect, it } from 'vitest';
import type { DocumentItem } from '../documents/api';
import { MAX_SUGGESTIONS, pickSuggestions } from './suggestions';

function doc(
  id: string,
  suggestions: string[],
  status: DocumentItem['status'] = 'ready',
): DocumentItem {
  return {
    id,
    kind: 'document',
    filename: `${id}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 1,
    status,
    error: null,
    pageCount: null,
    chunkCount: 1,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    progress: null,
    suggestions,
    createdAt: '2026-10-07T10:00:00Z',
  };
}

describe('pickSuggestions', () => {
  it('is empty without documents or without suggestions', () => {
    expect(pickSuggestions([])).toEqual([]);
    expect(pickSuggestions([doc('a', [])])).toEqual([]);
  });

  it('ignores documents that are not ready', () => {
    expect(pickSuggestions([doc('a', ['Q1?'], 'processing'), doc('b', ['Q2?'], 'failed')])).toEqual(
      [],
    );
  });

  it('takes the first question of every document before any second one', () => {
    const result = pickSuggestions([doc('a', ['a1?', 'a2?', 'a3?']), doc('b', ['b1?', 'b2?'])]);

    expect(result).toEqual(['a1?', 'b1?', 'a2?', 'b2?']);
  });

  it('never offers more than the limit', () => {
    const result = pickSuggestions([doc('a', ['1?', '2?', '3?']), doc('b', ['4?', '5?', '6?'])]);

    expect(result).toHaveLength(MAX_SUGGESTIONS);
  });

  it('does not repeat a question two documents share', () => {
    expect(pickSuggestions([doc('a', ['Same?', 'a2?']), doc('b', ['Same?'])])).toEqual([
      'Same?',
      'a2?',
    ]);
  });
});
