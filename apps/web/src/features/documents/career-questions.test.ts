import { describe, expect, it } from 'vitest';
import type { DocumentItem } from './api';
import {
  cardQuestions,
  careerQuestions,
  MAX_CAREER_QUESTIONS,
  readyJobs,
  readyResume,
} from './career-questions';

function doc(overrides: Partial<DocumentItem>): DocumentItem {
  return {
    id: 'd1',
    kind: 'document',
    filename: 'file',
    mimeType: 'text/plain',
    sizeBytes: 100,
    status: 'ready',
    error: null,
    pageCount: null,
    chunkCount: 4,
    fileCount: null,
    repoUrl: null,
    repoRef: null,
    commitSha: null,
    meetingHeldOn: null,
    participants: null,
    durationMs: null,
    notes: null,
    jobNumber: null,
    profile: null,
    fit: null,
    progress: null,
    suggestions: [],
    createdAt: '2026-10-14T10:00:00Z',
    ...overrides,
  };
}

const resume = (overrides: Partial<DocumentItem> = {}) =>
  doc({ id: 'r1', kind: 'resume', filename: 'cv', ...overrides });
const job = (jobNumber: number | null, overrides: Partial<DocumentItem> = {}) =>
  doc({
    id: `j${jobNumber}`,
    kind: 'job_posting',
    filename: `Role ${jobNumber}`,
    jobNumber,
    ...overrides,
  });

describe('readyResume and readyJobs', () => {
  it('take only what is ready', () => {
    const all = [
      resume({ status: 'processing' }),
      job(1, { status: 'failed' }),
      job(2),
      doc({ id: 'x', status: 'ready' }),
    ];

    expect(readyResume(all)).toBeUndefined();
    expect(readyJobs(all).map((j) => j.id)).toEqual(['j2']);
    expect(readyResume([...all, resume({ id: 'r2' })])?.id).toBe('r2');
  });

  it('order the postings by the best fit, then by number, and put those without a fit last', () => {
    const jobs = readyJobs([
      job(3),
      job(1, { fit: { coverage: 40, mustCoverage: null } }),
      job(2, { fit: { coverage: 80, mustCoverage: null } }),
      job(4, { fit: { coverage: 40, mustCoverage: null } }),
      job(0),
    ]);

    expect(jobs.map((j) => j.jobNumber)).toEqual([2, 1, 4, 0, 3]);
  });

  it('do not change the list they are given', () => {
    const all = [job(2), job(1)];

    readyJobs(all);

    expect(all.map((j) => j.jobNumber)).toEqual([2, 1]);
  });
});

describe('careerQuestions', () => {
  it('has nothing without a resume or a posting', () => {
    expect(careerQuestions([])).toEqual([]);
    expect(careerQuestions([doc({ kind: 'repository' })])).toEqual([]);
  });

  it('has nothing for sources that are not ready', () => {
    expect(
      careerQuestions([resume({ status: 'processing' }), job(1, { status: 'failed' })]),
    ).toEqual([]);
  });

  it('asks about the resume alone when there are no postings', () => {
    expect(careerQuestions([resume()])).toEqual([
      'What are the strongest skills on my resume?',
      'Summarize my experience.',
    ]);
  });

  it('asks what the postings require when there is no resume', () => {
    expect(careerQuestions([job(2)])).toEqual(['What does Job #2 require?']);
    expect(careerQuestions([job(2), job(5), job(7)])).toEqual([
      'What does Job #2 require?',
      'What does Job #5 require?',
    ]);
  });

  it('asks about gaps, alignment and the interview for the one posting', () => {
    expect(careerQuestions([resume(), job(2)])).toEqual([
      'What skills am I missing for Job #2?',
      'How does my experience align with Job #2?',
      'Prepare me for an interview for Job #2.',
    ]);
  });

  it('asks which job fits best, and then about the best-fitting one, when there are several', () => {
    expect(
      careerQuestions([
        resume(),
        job(1, { fit: { coverage: 30, mustCoverage: null } }),
        job(2, { fit: { coverage: 70, mustCoverage: null } }),
      ]),
    ).toEqual([
      'Which job fits me best?',
      'What skills am I missing for Job #2?',
      'How does my experience align with Job #2?',
      'Prepare me for an interview for Job #2.',
    ]);
  });

  it('never has more than the limit', () => {
    expect(careerQuestions([resume(), job(1), job(2), job(3)]).length).toBeLessThanOrEqual(
      MAX_CAREER_QUESTIONS,
    );
  });

  it('refers to a posting without a number in general words', () => {
    expect(careerQuestions([resume(), job(null, { id: 'jn' })])[0]).toBe(
      'What skills am I missing for this job?',
    );
  });

  it('is the same whatever the order of the library', () => {
    const a = [resume(), job(1), job(2)];

    expect(careerQuestions([...a].reverse())).toEqual(careerQuestions(a));
  });
});

describe('cardQuestions', () => {
  it('asks about the resume on the card of the resume, limited to the resume', () => {
    expect(cardQuestions(resume(), [resume(), job(2)])).toEqual({
      questions: ['What are the strongest skills on my resume?', 'Summarize my experience.'],
      sourceIds: ['r1'],
    });
  });

  it('asks about the posting on its card, limited to the resume and the posting', () => {
    expect(cardQuestions(job(2), [resume(), job(2), job(3)])).toEqual({
      questions: [
        'What skills am I missing for Job #2?',
        'How does my experience align with Job #2?',
        'Prepare me for an interview for Job #2.',
      ],
      sourceIds: ['r1', 'j2'],
    });
  });

  it('asks only what the posting itself says when the resume is not ready, limited to the posting', () => {
    expect(cardQuestions(job(2), [resume({ status: 'processing' }), job(2)])).toEqual({
      questions: ['What does Job #2 require?', 'What are the responsibilities of Job #2?'],
      sourceIds: ['j2'],
    });
    expect(cardQuestions(job(2), [job(2)]).sourceIds).toEqual(['j2']);
  });

  it('has no questions for a card that is not ready', () => {
    expect(cardQuestions(job(2, { status: 'processing' }), [resume(), job(2)]).questions).toEqual(
      [],
    );
    expect(cardQuestions(resume({ status: 'failed' }), []).questions).toEqual([]);
  });
});
