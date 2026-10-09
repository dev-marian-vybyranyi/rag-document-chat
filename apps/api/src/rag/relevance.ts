import type { RetrievedChunk } from './fusion.js';
import type { RetrievalMode } from './retriever.js';

export const DEFAULT_RELEVANCE_THRESHOLD = 0.65;

export interface RelevanceThresholds {
  document: number;
  code: number;
}

export interface Relevance {
  relevant: boolean;
  bestScore: number | null;
  threshold: number;
}

export function relevanceThresholds(settings: {
  RELEVANCE_THRESHOLD: number;
  CODE_RELEVANCE_THRESHOLD?: number | undefined;
}): RelevanceThresholds {
  return {
    document: settings.RELEVANCE_THRESHOLD,
    code: settings.CODE_RELEVANCE_THRESHOLD ?? settings.RELEVANCE_THRESHOLD,
  };
}

export function assessRelevance(
  chunks: RetrievedChunk[],
  mode: RetrievalMode,
  threshold: number | RelevanceThresholds = DEFAULT_RELEVANCE_THRESHOLD,
): Relevance {
  const thresholds =
    typeof threshold === 'number' ? { document: threshold, code: threshold } : threshold;
  const thresholdOf = (chunk: RetrievedChunk) =>
    chunk.code ? thresholds.code : thresholds.document;

  if (chunks.length === 0)
    return { relevant: false, bestScore: null, threshold: thresholds.document };

  if (mode === 'keyword-only') {
    return { relevant: true, bestScore: null, threshold: thresholds.document };
  }

  const scored = chunks.flatMap((chunk) =>
    typeof chunk.vectorScore === 'number'
      ? [{ score: chunk.vectorScore, threshold: thresholdOf(chunk) }]
      : [],
  );
  if (scored.length === 0)
    return { relevant: false, bestScore: null, threshold: thresholds.document };

  const best = scored.reduce((a, b) => (b.score - b.threshold > a.score - a.threshold ? b : a));
  return {
    relevant: best.score >= best.threshold,
    bestScore: best.score,
    threshold: best.threshold,
  };
}
