import { createOpenAI } from '@ai-sdk/openai';
import type { Env } from '../../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../../db/schema.js';
import {
  createJobProfileExtractor,
  createNoopJobProfileExtractor,
} from '../../career/job-profile.js';
import { createFitMatcher, createNoopFitMatcher } from '../../career/matcher.js';
import {
  createNoopResumeProfileExtractor,
  createResumeProfileExtractor,
} from '../../career/resume-profile.js';
import { createNoopNotesExtractor, createNotesExtractor } from '../../meetings/notes-extractor.js';
import { createDiarizingTranscriber } from '../../meetings/transcribe-with-diarization.js';
import { createUnconfiguredTranscriber } from '../../meetings/transcriber.js';
import { createPassthroughRewriter, createQueryRewriter } from '../../rag/rewrite.js';
import { createNoopSuggester, createQuestionSuggester } from '../../rag/suggest.js';
import {
  createEmbedder,
  createUnconfiguredEmbedder,
  type EmbeddingProviderOptions,
} from '../embeddings.js';
import type { AiProvider } from '../provider.js';

export type OpenAiProviderEnv = Pick<
  Env,
  | 'OPENAI_API_KEY'
  | 'EMBEDDING_MODEL'
  | 'EMBEDDING_TOKENS_PER_MINUTE'
  | 'REWRITE_MODEL'
  | 'CHAT_MODEL'
  | 'CHAT_THINKING_LEVEL'
  | 'TRANSCRIPTION_MODEL'
>;

const KEY_VARIABLE = 'OPENAI_API_KEY';

export function openAiEmbeddingOptions(dimensions: number) {
  return (): EmbeddingProviderOptions => ({ openai: { dimensions } });
}

export function createOpenAiProvider(env: OpenAiProviderEnv): AiProvider {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      name: 'openai',
      keyVariable: KEY_VARIABLE,
      configured: false,
      embedder: createUnconfiguredEmbedder(KEY_VARIABLE),
      chat: { model: null },
      createRewriter: () => createPassthroughRewriter(),
      createSuggester: () => createNoopSuggester(),
      createNotesExtractor: () => createNoopNotesExtractor(),
      createResumeProfileExtractor: () => createNoopResumeProfileExtractor(),
      createJobProfileExtractor: () => createNoopJobProfileExtractor(),
      createFitMatcher: () => createNoopFitMatcher(),
      createTranscriber: () => createUnconfiguredTranscriber(KEY_VARIABLE),
      createJudgeModel: () => {
        throw new Error(`${KEY_VARIABLE} is not set`);
      },
    };
  }

  const openai = createOpenAI({ apiKey });
  const lowReasoning = { openai: { reasoningEffort: 'low' } } as const;
  const minimalReasoning = { openai: { reasoningEffort: 'minimal' } } as const;

  return {
    name: 'openai',
    keyVariable: KEY_VARIABLE,
    configured: true,
    embedder: createEmbedder({
      model: openai.embedding(env.EMBEDDING_MODEL),
      dimensions: EMBEDDING_DIMENSIONS,
      tokensPerMinute: env.EMBEDDING_TOKENS_PER_MINUTE,
      providerOptions: openAiEmbeddingOptions(EMBEDDING_DIMENSIONS),
    }),
    chat: {
      model: openai.chat(env.CHAT_MODEL),
      providerOptions: { openai: { reasoningEffort: env.CHAT_THINKING_LEVEL } },
    },
    createRewriter: (logger) =>
      createQueryRewriter({
        model: openai.chat(env.REWRITE_MODEL),
        logger,
        providerOptions: minimalReasoning,
      }),
    createSuggester: (logger) =>
      createQuestionSuggester({
        model: openai.chat(env.REWRITE_MODEL),
        logger,
        providerOptions: minimalReasoning,
      }),
    createNotesExtractor: (logger) =>
      createNotesExtractor({
        model: openai.chat(env.REWRITE_MODEL),
        logger,
        providerOptions: lowReasoning,
      }),
    createResumeProfileExtractor: (logger) =>
      createResumeProfileExtractor({
        model: openai.chat(env.REWRITE_MODEL),
        logger,
        providerOptions: lowReasoning,
      }),
    createJobProfileExtractor: (logger) =>
      createJobProfileExtractor({
        model: openai.chat(env.REWRITE_MODEL),
        logger,
        providerOptions: lowReasoning,
      }),
    createFitMatcher: (logger) =>
      createFitMatcher({
        model: openai.chat(env.REWRITE_MODEL),
        logger,
        providerOptions: lowReasoning,
      }),
    createTranscriber: (logger) =>
      createDiarizingTranscriber({
        model: openai.transcription(env.TRANSCRIPTION_MODEL),
        logger,
      }),
    createJudgeModel: (modelId, thinkingLevel) => ({
      model: openai.chat(modelId),
      providerOptions: { openai: { reasoningEffort: thinkingLevel } },
    }),
  };
}
