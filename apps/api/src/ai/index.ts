import { createGoogle } from '@ai-sdk/google';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import {
  createPassthroughRewriter,
  createQueryRewriter,
  type QueryRewriter,
} from '../rag/rewrite.js';
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

export function createQueryRewriterFromEnv(
  env: Pick<Env, 'GOOGLE_GENERATIVE_AI_API_KEY' | 'REWRITE_MODEL'>,
  logger: Logger,
): QueryRewriter {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return createPassthroughRewriter();
  const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  return createQueryRewriter({
    model: google(env.REWRITE_MODEL),
    logger,
    providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
  });
}
