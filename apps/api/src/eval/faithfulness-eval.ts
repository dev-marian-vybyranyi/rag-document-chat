import { NO_ANSWER_PREFIX } from '../rag/prompt.js';
import type { GoldenQuestion, GoldenSet } from './golden.js';
import { claimScores, type Judge, type JudgeSource, type JudgeVerdict } from './judge.js';

export interface AskedAnswer {
  text: string;
  sources: JudgeSource[];
  declined: boolean;
  error: string | null;
}

export interface Asker {
  ask(question: GoldenQuestion): Promise<AskedAnswer>;
}

export type Outcome = 'answered' | 'declined' | 'refused' | 'failed';

export interface FaithfulnessRow {
  id: string;
  type: GoldenQuestion['type'];
  hard: boolean;
  question: string;
  outcome: Outcome;
  answer: string;
  sourceCount: number;
  verdict: JudgeVerdict | null;
  judgeError: string | null;
  error: string | null;
}

export function classify(asked: AskedAnswer): Outcome {
  if (asked.error !== null) return 'failed';
  if (asked.declined) return 'declined';
  if (asked.text.trim().startsWith(NO_ANSWER_PREFIX)) return 'refused';
  return 'answered';
}

export interface EvalProgress {
  done: number;
  total: number;
  id: string;
}

export async function evaluateFaithfulness({
  golden,
  asker,
  judge,
  onProgress,
  only,
}: {
  golden: GoldenSet;
  asker: Asker;
  judge: Judge;
  onProgress?: (progress: EvalProgress) => void;
  only?: (question: GoldenQuestion) => boolean;
}): Promise<FaithfulnessRow[]> {
  const questions = golden.questions.filter((question) => (only ? only(question) : true));
  const rows: FaithfulnessRow[] = [];

  for (const question of questions) {
    const asked = await asker.ask(question);
    const outcome = classify(asked);
    let verdict: JudgeVerdict | null = null;
    let judgeError: string | null = null;

    if (outcome === 'answered') {
      try {
        verdict = await judge.judge({
          question: question.question,
          answer: asked.text,
          sources: asked.sources,
          reference: question.type === 'answerable' ? question.answer : null,
        });
      } catch (error) {
        judgeError = error instanceof Error ? error.message : String(error);
      }
    }

    rows.push({
      id: question.id,
      type: question.type,
      hard: question.type === 'unanswerable' && (question.hard ?? false),
      question: question.question,
      outcome,
      answer: asked.text,
      sourceCount: asked.sources.length,
      verdict,
      judgeError,
      error: asked.error,
    });
    onProgress?.({ done: rows.length, total: questions.length, id: question.id });
  }
  return rows;
}

export interface FaithfulnessSummary {
  answerable: {
    questions: number;
    answered: number;
    declinedByThreshold: number;
    refusedByModel: number;
    failed: number;
    unjudged: number;
    claims: number;
    supportedClaims: number;
    faithfulness: number | null;
    fullyFaithful: number;
    citedClaims: number;
    correctCitations: number;
    citationAccuracy: number | null;
    correct: number;
    partial: number;
    incorrect: number;
  };
  unanswerable: {
    questions: number;
    declinedByThreshold: number;
    refusedByModel: number;
    answered: number;
    answeredWithUnsupportedClaims: number;
    failed: number;
    hardQuestions: number;
    hardRefused: number;
  };
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export function summarizeFaithfulness(rows: FaithfulnessRow[]): FaithfulnessSummary {
  const answerableRows = rows.filter((row) => row.type === 'answerable');
  const unanswerableRows = rows.filter((row) => row.type === 'unanswerable');
  const count = (list: FaithfulnessRow[], outcome: Outcome) =>
    list.filter((row) => row.outcome === outcome).length;

  const judged = answerableRows.filter((row) => row.verdict !== null);
  const scores = judged.map((row) => claimScores(row.verdict!));
  const sum = (pick: (s: ReturnType<typeof claimScores>) => number) =>
    scores.reduce((total, s) => total + pick(s), 0);
  const claims = sum((s) => s.claims);
  const supportedClaims = sum((s) => s.supported);
  const citedClaims = sum((s) => s.cited);
  const correctCitations = sum((s) => s.citedCorrect);
  const correctness = (value: JudgeVerdict['correctness']) =>
    judged.filter((row) => row.verdict!.correctness === value).length;

  const answeredUnanswerable = unanswerableRows.filter((row) => row.outcome === 'answered');
  const hard = unanswerableRows.filter((row) => row.hard);

  return {
    answerable: {
      questions: answerableRows.length,
      answered: count(answerableRows, 'answered'),
      declinedByThreshold: count(answerableRows, 'declined'),
      refusedByModel: count(answerableRows, 'refused'),
      failed: count(answerableRows, 'failed'),
      unjudged: answerableRows.filter((row) => row.outcome === 'answered' && !row.verdict).length,
      claims,
      supportedClaims,
      faithfulness: ratio(supportedClaims, claims),
      fullyFaithful: scores.filter((s) => s.claims > 0 && s.supported === s.claims).length,
      citedClaims,
      correctCitations,
      citationAccuracy: ratio(correctCitations, citedClaims),
      correct: correctness('correct'),
      partial: correctness('partial'),
      incorrect: correctness('incorrect'),
    },
    unanswerable: {
      questions: unanswerableRows.length,
      declinedByThreshold: count(unanswerableRows, 'declined'),
      refusedByModel: count(unanswerableRows, 'refused'),
      answered: answeredUnanswerable.length,
      answeredWithUnsupportedClaims: answeredUnanswerable.filter((row) => {
        const verdict = row.verdict;
        return verdict !== null && verdict.claims.some((claim) => !claim.supported);
      }).length,
      failed: count(unanswerableRows, 'failed'),
      hardQuestions: hard.length,
      hardRefused: hard.filter((row) => row.outcome === 'declined' || row.outcome === 'refused')
        .length,
    },
  };
}
