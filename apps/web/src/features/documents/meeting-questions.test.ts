import { describe, expect, it } from 'vitest';
import type { DocumentItem, MeetingNotes } from './api';
import { meetingQuestions, suggestionsOf } from './meeting-questions';

const notes: MeetingNotes = {
  summary: 'The team planned the release.',
  topics: ['Marketing budget', 'Roadmap'],
  decisions: [{ text: 'Ship on Friday.', startMs: 120_000, evidence: 'x' }],
  actionItems: [
    { task: 'Book the room.', owner: null, due: null, startMs: 10_000, evidence: 'y' },
    { task: 'Update the changelog.', owner: 'Carol', due: 'today', startMs: 70_000, evidence: 'z' },
  ],
  openQuestions: ['Who pays?'],
};

function meeting(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'm1',
    kind: 'transcript',
    filename: 'Release sync',
    mimeType: 'text/plain',
    sizeBytes: 100,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 3,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: ['Alice', 'Bob', 'Carol'],
    durationMs: 600_000,
    notes,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-07T10:00:00Z',
    ...overrides,
  };
}

describe('meetingQuestions', () => {
  it('asks about the decisions, the action items, the owner and a topic, in that order', () => {
    expect(meetingQuestions(meeting())).toEqual([
      'What decisions were made in Release sync?',
      'What are the action items from Release sync?',
      'What is Carol responsible for in Release sync?',
      'What did Bob say about Marketing budget?',
    ]);
  });

  it('asks about what was left open when there is room for it', () => {
    const questions = meetingQuestions(
      meeting({ notes: { ...notes, actionItems: [], topics: [] } }),
    );

    expect(questions).toEqual([
      'What decisions were made in Release sync?',
      'What was left open in Release sync?',
      'What was discussed in Release sync?',
      'What did Alice say in Release sync?',
    ]);
  });

  it('does not ask about what the notes did not find', () => {
    const questions = meetingQuestions(
      meeting({
        notes: { summary: 'Short.', topics: [], decisions: [], actionItems: [], openQuestions: [] },
      }),
    );

    expect(questions).toEqual([
      'What was discussed in Release sync?',
      'What did Alice say in Release sync?',
    ]);
  });

  it('still has questions to offer before there are notes', () => {
    expect(meetingQuestions(meeting({ notes: null }))).toEqual([
      'What was discussed in Release sync?',
      'What did Alice say in Release sync?',
    ]);
  });

  it('does not ask about a person when no one is known', () => {
    expect(meetingQuestions(meeting({ notes: null, participants: null }))).toEqual([
      'What was discussed in Release sync?',
    ]);
    expect(meetingQuestions(meeting({ notes: null, participants: [] }))).toEqual([
      'What was discussed in Release sync?',
    ]);
  });

  it('names a person other than the owner when there are two people, and the only one otherwise', () => {
    expect(meetingQuestions(meeting({ participants: ['Alice'] }))).toContain(
      'What did Alice say about Marketing budget?',
    );
  });

  it('takes the first owner that is named, and skips tasks nobody owns', () => {
    const questions = meetingQuestions(meeting());

    expect(questions).toContain('What is Carol responsible for in Release sync?');
    expect(questions.join(' ')).not.toContain('null');
  });

  it('shortens a long title so the question stays short', () => {
    const questions = meetingQuestions(meeting({ filename: 'x'.repeat(100) }));

    expect(questions[0]).toBe(`What decisions were made in ${'x'.repeat(49)}…?`);
    for (const question of questions) expect(question.length).toBeLessThanOrEqual(140);
  });

  it('leaves out a question that would still be too long', () => {
    const questions = meetingQuestions(
      meeting({
        notes: { ...notes, topics: ['t'.repeat(200)] },
        participants: ['Alice', 'Bob'],
      }),
    );

    expect(questions.some((q) => q.includes('ttt'))).toBe(false);
    expect(questions.length).toBeGreaterThan(0);
  });

  it('never offers more than four, or the same twice', () => {
    const questions = meetingQuestions(meeting());

    expect(questions).toHaveLength(4);
    expect(new Set(questions).size).toBe(4);
  });
});

describe('suggestionsOf', () => {
  it('composes the questions of a meeting, from its notes', () => {
    expect(suggestionsOf(meeting())).toEqual(meetingQuestions(meeting()));
  });

  it('follows the notes when they change', () => {
    const before = suggestionsOf(meeting({ notes: null }));
    const after = suggestionsOf(meeting());

    expect(after).not.toEqual(before);
    expect(after[0]).toBe('What decisions were made in Release sync?');
  });

  it('keeps the stored questions of a document or a repository', () => {
    const stored = ['What is HNSW?', 'How fast?'];

    expect(suggestionsOf(meeting({ kind: 'document', suggestions: stored }))).toEqual(stored);
    expect(suggestionsOf(meeting({ kind: 'repository', suggestions: stored }))).toEqual(stored);
  });

  it('ignores whatever the server stored for a meeting', () => {
    expect(suggestionsOf(meeting({ suggestions: ['A stored question?'] }))).not.toContain(
      'A stored question?',
    );
  });
});
