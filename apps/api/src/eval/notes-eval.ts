import type { MeetingNotes } from '../meetings/types.js';
import type { MeetingNotesTruth } from './golden-meetings.js';

export interface Tally {
  expected: number;
  found: number;
}

export interface NotesScore {
  meeting: string;
  hasNotes: boolean;
  decisions: Tally & { reported: number; supported: number; stale: number; proposals: number };
  actionItems: Tally & { reported: number; ownerCorrect: number; dueCorrect: number };
  openQuestions: Tally;
  missed: string[];
}

const hasAll = (text: string, keywords: string[]) => {
  const lower = text.toLowerCase();
  return keywords.every((keyword) => lower.includes(keyword.toLowerCase()));
};

const sameName = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : a.toLowerCase() === b.toLowerCase();

const dueMatches = (reported: string | null, expected: string | null) =>
  expected === null
    ? reported === null
    : reported !== null && reported.toLowerCase().includes(expected.toLowerCase());

export function scoreNotes(truth: MeetingNotesTruth, notes: MeetingNotes | null): NotesScore {
  const decisions = notes?.decisions ?? [];
  const items = notes?.actionItems ?? [];
  const questions = notes?.openQuestions ?? [];
  const missed: string[] = [];

  const decisionsFound = truth.decisions.filter((expected) => {
    const found = decisions.some((d) => hasAll(d.text, expected.keywords));
    if (!found) missed.push(`decision: ${expected.keywords.join(' + ')}`);
    return found;
  }).length;

  let ownerCorrect = 0;
  let dueCorrect = 0;
  let actionsFound = 0;
  for (const expected of truth.actionItems) {
    const reported = items.find((item) => hasAll(item.task, expected.keywords));
    if (!reported) {
      missed.push(`action item: ${expected.keywords.join(' + ')}`);
      continue;
    }
    actionsFound++;
    if (sameName(reported.owner, expected.owner)) ownerCorrect++;
    else missed.push(`owner of ${expected.keywords.join(' + ')}: got ${reported.owner ?? 'none'}`);
    if (dueMatches(reported.due, expected.due)) dueCorrect++;
    else missed.push(`due of ${expected.keywords.join(' + ')}: got ${reported.due ?? 'none'}`);
  }

  const questionsFound = truth.openQuestions.filter((expected) => {
    const found = questions.some((q) => hasAll(q, expected.keywords));
    if (!found) missed.push(`open question: ${expected.keywords.join(' + ')}`);
    return found;
  }).length;

  return {
    meeting: truth.meeting,
    hasNotes: notes !== null,
    decisions: {
      expected: truth.decisions.length,
      found: decisionsFound,
      reported: decisions.length,
      supported: decisions.filter((d) => truth.decisions.some((t) => hasAll(d.text, t.keywords)))
        .length,
      stale: decisions.filter((d) => truth.staleDecisions.some((s) => hasAll(d.text, s.keywords)))
        .length,
      proposals: decisions.filter((d) => truth.notDecisions.some((n) => hasAll(d.text, n.keywords)))
        .length,
    },
    actionItems: {
      expected: truth.actionItems.length,
      found: actionsFound,
      reported: items.length,
      ownerCorrect,
      dueCorrect,
    },
    openQuestions: { expected: truth.openQuestions.length, found: questionsFound },
    missed,
  };
}

export interface NotesSummary {
  meetings: number;
  withNotes: number;
  decisionRecall: number;
  decisionPrecision: number | null;
  staleReported: number;
  proposalsReported: number;
  actionRecall: number;
  ownerAccuracy: number | null;
  dueAccuracy: number | null;
  questionRecall: number;
}

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
const optionalRatio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const sum = (scores: NotesScore[], pick: (score: NotesScore) => number) =>
  scores.reduce((total, score) => total + pick(score), 0);

export function summarizeNotes(scores: NotesScore[]): NotesSummary {
  return {
    meetings: scores.length,
    withNotes: scores.filter((s) => s.hasNotes).length,
    decisionRecall: ratio(
      sum(scores, (s) => s.decisions.found),
      sum(scores, (s) => s.decisions.expected),
    ),
    decisionPrecision: optionalRatio(
      sum(scores, (s) => s.decisions.supported),
      sum(scores, (s) => s.decisions.reported),
    ),
    staleReported: sum(scores, (s) => s.decisions.stale),
    proposalsReported: sum(scores, (s) => s.decisions.proposals),
    actionRecall: ratio(
      sum(scores, (s) => s.actionItems.found),
      sum(scores, (s) => s.actionItems.expected),
    ),
    ownerAccuracy: optionalRatio(
      sum(scores, (s) => s.actionItems.ownerCorrect),
      sum(scores, (s) => s.actionItems.found),
    ),
    dueAccuracy: optionalRatio(
      sum(scores, (s) => s.actionItems.dueCorrect),
      sum(scores, (s) => s.actionItems.found),
    ),
    questionRecall: ratio(
      sum(scores, (s) => s.openQuestions.found),
      sum(scores, (s) => s.openQuestions.expected),
    ),
  };
}
