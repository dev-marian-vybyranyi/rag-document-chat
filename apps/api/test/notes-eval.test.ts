import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGoldenMeetings, type MeetingNotesTruth } from '../src/eval/golden-meetings.js';
import { scoreNotes, summarizeNotes } from '../src/eval/notes-eval.js';
import type { MeetingNotes } from '../src/meetings/types.js';

const golden = loadGoldenMeetings(
  join(import.meta.dirname, '../../../scripts/eval/golden-meetings.json'),
);
const planning = golden.notes.find((n) => n.meeting === 'product-planning.txt')!;

const truth: MeetingNotesTruth = {
  meeting: 'x.txt',
  decisions: [
    { keywords: ['dark mode', 'q4'], quote: 'q'.repeat(12) },
    { keywords: ['offline sync', 'q1'], quote: 'q'.repeat(12) },
  ],
  staleDecisions: [{ keywords: ['headline'], quote: 'q'.repeat(12) }],
  notDecisions: [{ keywords: ['discount'], quote: 'q'.repeat(12) }],
  actionItems: [
    { owner: 'Lena', keywords: ['mockups'], due: '25', quote: 'q'.repeat(12) },
    { owner: null, keywords: ['roadmap', 'page'], due: null, quote: 'q'.repeat(12) },
  ],
  openQuestions: [{ keywords: ['enterprise'], quote: 'q'.repeat(12) }],
};

const decision = (text: string) => ({ text, startMs: 0, evidence: 'x' });
const action = (task: string, owner: string | null, due: string | null) => ({
  task,
  owner,
  due,
  startMs: 0,
  evidence: 'x',
});

const perfect: MeetingNotes = {
  summary: 's',
  topics: [],
  decisions: [decision('Ship dark mode in Q4.'), decision('Offline sync moves to Q1.')],
  actionItems: [
    action('Deliver the onboarding mockups.', 'Lena', 'September 25th'),
    action('Update the public roadmap page.', null, null),
  ],
  openQuestions: ['What to charge for the enterprise tier?'],
};

describe('scoreNotes', () => {
  it('gives full marks to notes that hold everything', () => {
    const score = scoreNotes(truth, perfect);

    expect(score).toMatchObject({
      hasNotes: true,
      decisions: { expected: 2, found: 2, reported: 2, supported: 2, stale: 0, proposals: 0 },
      actionItems: { expected: 2, found: 2, reported: 2, ownerCorrect: 2, dueCorrect: 2 },
      openQuestions: { expected: 1, found: 1 },
      missed: [],
    });
  });

  it('matches by keywords, whatever the case', () => {
    const score = scoreNotes(truth, {
      ...perfect,
      decisions: [decision('DARK MODE ships in q4'), decision('OFFLINE SYNC is now Q1')],
    });

    expect(score.decisions.found).toBe(2);
  });

  it('needs every keyword of an item, not just one', () => {
    const score = scoreNotes(truth, { ...perfect, decisions: [decision('Ship dark mode.')] });

    expect(score.decisions.found).toBe(0);
    expect(score.missed).toContain('decision: dark mode + q4');
    expect(score.missed).toContain('decision: offline sync + q1');
  });

  it('says what is missing', () => {
    const score = scoreNotes(truth, {
      ...perfect,
      actionItems: [],
      openQuestions: [],
    });

    expect(score.missed).toEqual([
      'action item: mockups',
      'action item: roadmap + page',
      'open question: enterprise',
    ]);
  });

  it('counts a superseded decision reported as final', () => {
    const score = scoreNotes(truth, {
      ...perfect,
      decisions: [...perfect.decisions, decision('Offline sync is the Q4 headline feature.')],
    });

    expect(score.decisions).toMatchObject({ reported: 3, supported: 2, stale: 1 });
  });

  it('counts a proposal reported as a decision', () => {
    const score = scoreNotes(truth, {
      ...perfect,
      decisions: [...perfect.decisions, decision('Give a discount for annual plans.')],
    });

    expect(score.decisions).toMatchObject({ reported: 3, supported: 2, proposals: 1 });
  });

  it('marks an owner who is wrong, or invented for a task nobody owns', () => {
    const wrong = scoreNotes(truth, {
      ...perfect,
      actionItems: [
        action('Deliver the onboarding mockups.', 'Priya', 'September 25th'),
        action('Update the public roadmap page.', 'Marcus', null),
      ],
    });

    expect(wrong.actionItems).toMatchObject({ found: 2, ownerCorrect: 0, dueCorrect: 2 });
    expect(wrong.missed).toEqual([
      'owner of mockups: got Priya',
      'owner of roadmap + page: got Marcus',
    ]);
  });

  it('accepts an owner in any case', () => {
    const score = scoreNotes(truth, {
      ...perfect,
      actionItems: [
        action('Deliver the onboarding mockups.', 'LENA', 'by the 25th'),
        perfect.actionItems[1]!,
      ],
    });

    expect(score.actionItems.ownerCorrect).toBe(2);
  });

  it('marks a deadline that is missing, wrong, or invented', () => {
    const score = scoreNotes(truth, {
      ...perfect,
      actionItems: [
        action('Deliver the onboarding mockups.', 'Lena', null),
        action('Update the public roadmap page.', null, 'Friday'),
      ],
    });

    expect(score.actionItems).toMatchObject({ found: 2, dueCorrect: 0 });
    expect(score.missed).toEqual(['due of mockups: got none', 'due of roadmap + page: got Friday']);
  });

  it('has nothing to give for a meeting without notes', () => {
    const score = scoreNotes(truth, null);

    expect(score).toMatchObject({
      hasNotes: false,
      decisions: { expected: 2, found: 0, reported: 0 },
      actionItems: { expected: 2, found: 0 },
    });
    expect(score.missed).toHaveLength(5);
  });

  it('can be scored against the real answer key', () => {
    const score = scoreNotes(planning, null);

    expect(score.decisions.expected).toBe(planning.decisions.length);
    expect(score.actionItems.expected).toBe(4);
  });
});

describe('summarizeNotes', () => {
  it('adds the meetings up before it divides', () => {
    const full = scoreNotes(truth, perfect);
    const empty = scoreNotes(truth, {
      ...perfect,
      decisions: [],
      actionItems: [],
      openQuestions: [],
    });

    expect(summarizeNotes([full, empty])).toEqual({
      meetings: 2,
      withNotes: 2,
      decisionRecall: 0.5,
      decisionPrecision: 1,
      staleReported: 0,
      proposalsReported: 0,
      actionRecall: 0.5,
      ownerAccuracy: 1,
      dueAccuracy: 1,
      questionRecall: 0.5,
    });
  });

  it('counts the meetings that have notes', () => {
    const summary = summarizeNotes([scoreNotes(truth, perfect), scoreNotes(truth, null)]);

    expect(summary).toMatchObject({ meetings: 2, withNotes: 1, decisionRecall: 0.5 });
  });

  it('leaves out the rates that have nothing to divide', () => {
    const summary = summarizeNotes([scoreNotes(truth, null)]);

    expect(summary.decisionPrecision).toBeNull();
    expect(summary.ownerAccuracy).toBeNull();
    expect(summary.dueAccuracy).toBeNull();
    expect(summary.decisionRecall).toBe(0);
  });

  it('adds up the mistakes', () => {
    const bad = scoreNotes(truth, {
      ...perfect,
      decisions: [
        ...perfect.decisions,
        decision('Offline sync is the Q4 headline feature.'),
        decision('Give a discount.'),
      ],
    });

    expect(summarizeNotes([bad, bad])).toMatchObject({
      staleReported: 2,
      proposalsReported: 2,
      decisionPrecision: 0.5,
    });
  });

  it('copes with no meetings', () => {
    expect(summarizeNotes([])).toMatchObject({
      meetings: 0,
      decisionRecall: 0,
      ownerAccuracy: null,
    });
  });
});
