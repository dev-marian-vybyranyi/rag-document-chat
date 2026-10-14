import type { LanguageModel } from 'ai';
import type { Logger } from 'pino';
import type { FitMatcher } from '../career/matcher.js';
import type { JobProfileExtractor } from '../career/job-profile.js';
import type { ResumeProfileExtractor } from '../career/resume-profile.js';
import type { ChatDeps } from '../chat/responder.js';
import type { QueryRewriter } from '../rag/rewrite.js';
import type { QuestionSuggester } from '../rag/suggest.js';
import type { NotesExtractor } from '../meetings/notes-extractor.js';
import type { Transcriber } from '../meetings/transcriber.js';
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
  createNotesExtractor(logger: Logger): NotesExtractor;
  createResumeProfileExtractor(logger: Logger): ResumeProfileExtractor;
  createJobProfileExtractor(logger: Logger): JobProfileExtractor;
  createFitMatcher(logger: Logger): FitMatcher;
  createTranscriber(logger: Logger): Transcriber;
  createJudgeModel(modelId: string, thinkingLevel: ThinkingLevel): JudgeModel;
}
