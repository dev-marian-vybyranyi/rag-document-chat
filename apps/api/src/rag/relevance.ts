import type { RetrievedChunk } from './fusion.js';
import type { RetrievalMode } from './retriever.js';

export const DEFAULT_RELEVANCE_THRESHOLD = 0.65;

export interface Relevance {
  relevant: boolean;
  bestScore: number | null;
}

export function assessRelevance(
  chunks: RetrievedChunk[],
  mode: RetrievalMode,
  threshold: number = DEFAULT_RELEVANCE_THRESHOLD,
): Relevance {
  if (chunks.length === 0) return { relevant: false, bestScore: null };

  if (mode === 'keyword-only') return { relevant: true, bestScore: null };

  const scores = chunks.flatMap((chunk) =>
    typeof chunk.vectorScore === 'number' ? [chunk.vectorScore] : [],
  );
  if (scores.length === 0) return { relevant: false, bestScore: null };

  const bestScore = Math.max(...scores);
  return { relevant: bestScore >= threshold, bestScore };
}
