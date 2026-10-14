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
    meetingHeldOn: null,
    participants: null,
    durationMs: null,
    notes: null,
    progress: null,
    jobNumber: null,
    profile: null,
    fit: null,
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

  describe('with a resume and job postings', () => {
    const resume = () => ({ ...doc('r1', []), kind: 'resume' as const, filename: 'cv' });
    const job = (n: number) => ({
      ...doc(`j${n}`, []),
      kind: 'job_posting' as const,
      filename: `Role ${n}`,
      jobNumber: n,
    });

    it('offers questions about them, which the documents themselves cannot have', () => {
      expect(pickSuggestions([resume(), job(2)])).toEqual([
        'What skills am I missing for Job #2?',
        'How does my experience align with Job #2?',
        'Prepare me for an interview for Job #2.',
      ]);
    });

    it('gives them one place among the questions of other documents, not all of them', () => {
      expect(pickSuggestions([doc('a', ['a1?', 'a2?']), resume(), job(2)])).toEqual([
        'a1?',
        'What skills am I missing for Job #2?',
        'a2?',
        'How does my experience align with Job #2?',
      ]);
    });

    it('does not offer them while the resume or the posting is not ready', () => {
      const waiting = { ...resume(), status: 'processing' as const };

      expect(pickSuggestions([waiting, job(2)])).toEqual(['What does Job #2 require?']);
      expect(pickSuggestions([waiting])).toEqual([]);
    });
  });
});
