export function firstRelevantRank(relevant: boolean[]): number | null {
  const index = relevant.indexOf(true);
  return index === -1 ? null : index + 1;
}

export interface RankSummary {
  questions: number;
  hitAt: Record<number, number>;
  mrr: number;
}

export function summarizeRanks(ranks: Array<number | null>, ks: number[]): RankSummary {
  const total = ranks.length;
  const share = (count: number) => (total === 0 ? 0 : count / total);
  const hitAt = Object.fromEntries(
    ks.map((k) => [k, share(ranks.filter((rank) => rank !== null && rank <= k).length)]),
  );
  const mrr = share(ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0));
  return { questions: total, hitAt, mrr };
}

export interface ThresholdPoint {
  threshold: number;
  answered: number;
  refused: number;
}

export function sweepThresholds(
  answerableScores: Array<number | null>,
  unanswerableScores: Array<number | null>,
  thresholds: number[],
): ThresholdPoint[] {
  const share = (count: number, total: number) => (total === 0 ? 0 : count / total);
  return thresholds.map((threshold) => ({
    threshold,
    answered: share(
      answerableScores.filter((score) => score !== null && score >= threshold).length,
      answerableScores.length,
    ),
    refused: share(
      unanswerableScores.filter((score) => score === null || score < threshold).length,
      unanswerableScores.length,
    ),
  }));
}

export const MIN_ANSWERED_SHARE = 0.95;

export interface ThresholdRecommendation {
  threshold: number;
  answered: number;
  refused: number;
}

/**
 * The strictest cut-off that still answers nearly every answerable question: refusing a question
 * the documents can answer is a failure the user sees at once, so that share is protected first
 * and the refusal of unanswerable ones is what is left to gain.
 */
export function recommendThreshold(
  points: ThresholdPoint[],
  minAnswered: number = MIN_ANSWERED_SHARE,
): ThresholdRecommendation | null {
  if (points.length === 0) return null;
  const eligible = points.filter((point) => point.answered >= minAnswered);
  const mostAnswered = Math.max(...points.map((point) => point.answered));
  const pool =
    eligible.length > 0 ? eligible : points.filter((point) => point.answered === mostAnswered);
  const bestRefused = Math.max(...pool.map((point) => point.refused));
  const best = pool.filter((point) => point.refused === bestRefused).at(-1)!;
  return { threshold: best.threshold, answered: best.answered, refused: best.refused };
}
