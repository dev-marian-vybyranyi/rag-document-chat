import { createGoogle } from '@ai-sdk/google';
import type { Env } from '../../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../../db/schema.js';
import { createPassthroughRewriter, createQueryRewriter } from '../../rag/rewrite.js';
import { createNoopSuggester, createQuestionSuggester } from '../../rag/suggest.js';
import {
  createEmbedder,
  createUnconfiguredEmbedder,
  type EmbeddingProviderOptions,
  type EmbeddingTask,
} from '../embeddings.js';
import type { AiProvider } from '../provider.js';

export type GoogleProviderEnv = Pick<
  Env,
  | 'GOOGLE_GENERATIVE_AI_API_KEY'
  | 'EMBEDDING_MODEL'
  | 'EMBEDDING_TOKENS_PER_MINUTE'
  | 'REWRITE_MODEL'
  | 'CHAT_MODEL'
  | 'CHAT_THINKING_LEVEL'
>;

const KEY_VARIABLE = 'GOOGLE_GENERATIVE_AI_API_KEY';

const TASK_TYPES = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
} as const satisfies Record<EmbeddingTask, string>;

export function googleEmbeddingOptions(dimensions: number) {
  return (task: EmbeddingTask): EmbeddingProviderOptions => ({
    google: { outputDimensionality: dimensions, taskType: TASK_TYPES[task] },
  });
}

export function createGoogleProvider(env: GoogleProviderEnv): AiProvider {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    return {
      name: 'google',
      keyVariable: KEY_VARIABLE,
      configured: false,
      embedder: createUnconfiguredEmbedder(KEY_VARIABLE),
      chat: { model: null },
      createRewriter: () => createPassthroughRewriter(),
      createSuggester: () => createNoopSuggester(),
    };
  }

  const google = createGoogle({ apiKey });
  const minimalThinking = { google: { thinkingConfig: { thinkingLevel: 'minimal' } } } as const;

  return {
    name: 'google',
    keyVariable: KEY_VARIABLE,
    configured: true,
    embedder: createEmbedder({
      model: google.embedding(env.EMBEDDING_MODEL),
      dimensions: EMBEDDING_DIMENSIONS,
      tokensPerMinute: env.EMBEDDING_TOKENS_PER_MINUTE,
      providerOptions: googleEmbeddingOptions(EMBEDDING_DIMENSIONS),
    }),
    chat: {
      model: google(env.CHAT_MODEL),
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: env.CHAT_THINKING_LEVEL } },
      },
    },
    createRewriter: (logger) =>
      createQueryRewriter({
        model: google(env.REWRITE_MODEL),
        logger,
        providerOptions: minimalThinking,
      }),
    createSuggester: (logger) =>
      createQuestionSuggester({
        model: google(env.REWRITE_MODEL),
        logger,
        providerOptions: minimalThinking,
      }),
  };
}
