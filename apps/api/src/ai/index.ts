import { createGoogle } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import {
  createPassthroughRewriter,
  createQueryRewriter,
  type QueryRewriter,
} from '../rag/rewrite.js';
import type { ChatDeps } from '../chat/responder.js';
import {
  createNoopSuggester,
  createQuestionSuggester,
  type QuestionSuggester,
} from '../rag/suggest.js';
import { createGeminiEmbedder, createUnconfiguredEmbedder, type Embedder } from './embeddings.js';

export function createEmbedderFromEnv(
  env: Pick<Env, 'GOOGLE_GENERATIVE_AI_API_KEY' | 'EMBEDDING_MODEL'> &
    Partial<Pick<Env, 'EMBEDDING_TOKENS_PER_MINUTE'>>,
): Embedder {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return createUnconfiguredEmbedder();
  return createGeminiEmbedder({
    apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    modelId: env.EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    tokensPerMinute: env.EMBEDDING_TOKENS_PER_MINUTE,
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

export interface ChatModelConfig {
  model: LanguageModel | null;
  providerOptions?: ChatDeps['providerOptions'];
}

export function createChatModelFromEnv(
  env: Pick<Env, 'GOOGLE_GENERATIVE_AI_API_KEY' | 'CHAT_MODEL' | 'CHAT_THINKING_LEVEL'>,
): ChatModelConfig {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return { model: null };
  const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  return {
    model: google(env.CHAT_MODEL),
    providerOptions: { google: { thinkingConfig: { thinkingLevel: env.CHAT_THINKING_LEVEL } } },
  };
}

export function createQuestionSuggesterFromEnv(
  env: Pick<Env, 'GOOGLE_GENERATIVE_AI_API_KEY' | 'REWRITE_MODEL'>,
  logger: Logger,
): QuestionSuggester {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return createNoopSuggester();
  const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  return createQuestionSuggester({
    model: google(env.REWRITE_MODEL),
    logger,
    providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
  });
}
