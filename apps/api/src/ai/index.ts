import type { Env } from '../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import { createGeminiEmbedder, createUnconfiguredEmbedder, type Embedder } from './embeddings.js';

export function createEmbedderFromEnv(
  env: Pick<Env, 'GOOGLE_GENERATIVE_AI_API_KEY' | 'EMBEDDING_MODEL'>,
): Embedder {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return createUnconfiguredEmbedder();
  return createGeminiEmbedder({
    apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    modelId: env.EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  });
}
