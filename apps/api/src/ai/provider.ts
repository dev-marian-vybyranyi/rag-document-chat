import type { LanguageModel } from 'ai';
import type { Logger } from 'pino';
import type { ChatDeps } from '../chat/responder.js';
import type { QueryRewriter } from '../rag/rewrite.js';
import type { QuestionSuggester } from '../rag/suggest.js';
import type { Embedder } from './embeddings.js';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatModelConfig {
  model: LanguageModel | null;
  providerOptions?: ChatDeps['providerOptions'];
}

export interface JudgeModel {
  model: LanguageModel;
  providerOptions: NonNullable<ChatDeps['providerOptions']>;
}

export interface AiProvider {
  name: string;
  keyVariable: string;
  configured: boolean;
  embedder: Embedder;
  chat: ChatModelConfig;
  createRewriter(logger: Logger): QueryRewriter;
  createSuggester(logger: Logger): QuestionSuggester;
  createJudgeModel(modelId: string, thinkingLevel: ThinkingLevel): JudgeModel;
}
