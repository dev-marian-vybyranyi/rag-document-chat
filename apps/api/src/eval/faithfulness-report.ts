import type { FaithfulnessRow, FaithfulnessSummary } from './faithfulness-eval.js';

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`);
const of = (part: number, whole: number) => `${part}/${whole}`;

export function formatFaithfulnessReport(
  summary: FaithfulnessSummary,
  rows: FaithfulnessRow[],
): string {
  const a = summary.answerable;
  const u = summary.unanswerable;
  const out: string[] = [];

  out.push(
    `Answerable questions (${a.questions})`,
    `  answered                      ${of(a.answered, a.questions)}`,
    `  refused by the threshold      ${of(a.declinedByThreshold, a.questions)}   (should be 0)`,
    `  refused by the model          ${of(a.refusedByModel, a.questions)}   (should be 0)`,
    `  failed                        ${of(a.failed, a.questions)}`,
    `  not judged (judge failed)     ${of(a.unjudged, a.answered)}`,
    '',
    `  faithfulness (claims supported by the sources)  ${pct(a.faithfulness)}  (${of(a.supportedClaims, a.claims)} claims)`,
    `  answers with every claim supported              ${of(a.fullyFaithful, a.answered - a.unjudged)}`,
    `  citation accuracy (cited source supports claim) ${pct(a.citationAccuracy)}  (${of(a.correctCitations, a.citedClaims)} citations)`,
    `  correct / partial / incorrect vs the reference  ${a.correct} / ${a.partial} / ${a.incorrect}`,
    '',
    `Unanswerable questions (${u.questions})`,
    `  refused by the threshold      ${of(u.declinedByThreshold, u.questions)}`,
    `  refused by the model          ${of(u.refusedByModel, u.questions)}`,
    `  answered anyway               ${of(u.answered, u.questions)}   (${u.answeredWithUnsupportedClaims} with claims the sources do not support)`,
    `  failed                        ${of(u.failed, u.questions)}`,
    `  hard ones refused             ${of(u.hardRefused, u.hardQuestions)}`,
  );

  const problems = rows.filter((row) => {
    if (row.type === 'answerable') {
      if (row.outcome !== 'answered') return true;
      const v = row.verdict;
      return v === null || v.correctness !== 'correct' || v.claims.some((c) => !c.supported);
    }
    return row.outcome === 'answered' || row.outcome === 'failed';
  });
  out.push('', `Questions to look at (${problems.length})`);
  for (const row of problems) {
    const verdict = row.verdict;
    const detail =
      row.outcome !== 'answered'
        ? row.outcome === 'failed'
          ? `failed: ${row.error}`
          : row.outcome
        : verdict
          ? `${verdict.correctness}; ${verdict.claims.filter((c) => !c.supported).length} unsupported; ${verdict.notes}`
          : `not judged: ${row.judgeError ?? 'unknown'}`;
    out.push(`  ${row.id} [${row.type}] ${detail}`);
  }
  return out.join('\n');
}
