import {
  createUIMessageStream,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import type { Logger } from 'pino';
import { buildChatPrompt, NO_ANSWER_PREFIX, type PromptSource } from '../rag/prompt.js';
import { assessRelevance, DEFAULT_RELEVANCE_THRESHOLD } from '../rag/relevance.js';
import type { RetrievedChunk } from '../rag/fusion.js';
import type { QueryRewriter } from '../rag/rewrite.js';
import type { Retriever } from '../rag/retriever.js';
import { chatFailureMessage } from './errors.js';
import { DEFAULT_CHAT_TITLE, type ChatRecord, type ChatRepository } from './repository.js';
import type { MessageRetrieval, MessageSource } from './types.js';

export const NO_ANSWER_MESSAGE = `${NO_ANSWER_PREFIX} Try rephrasing the question, or upload a document that covers it.`;
export const MAX_QUESTION_LENGTH = 2000;
export const MAX_TITLE_FROM_QUESTION = 60;
export const EXCERPT_LENGTH = 300;
export const MAX_ANSWER_TOKENS = 1024;
export const ANSWER_TIMEOUT = { totalMs: 60_000, chunkMs: 20_000 };

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

export interface ChatDeps {
  retriever: Retriever;
  rewriter: QueryRewriter;
  model: LanguageModel | null;
  relevanceThreshold?: number;
  providerOptions?: ProviderOptions;
}

export type ChatStage = 'searching' | 'answering';

export type ChatUIMessage = UIMessage<
  never,
  {
    status: { stage: ChatStage };
    sources: { sources: MessageSource[]; retrieval: MessageRetrieval };
  }
>;

interface RespondInput {
  chat: ChatRecord;
  userId: string;
  question: string;
  signal?: AbortSignal;
}

export function titleFromQuestion(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_TITLE_FROM_QUESTION) return flat;
  return `${flat.slice(0, MAX_TITLE_FROM_QUESTION - 1).trimEnd()}…`;
}

export function toMessageSources(
  sources: PromptSource[],
  chunks: RetrievedChunk[],
): MessageSource[] {
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  return sources.flatMap((source) => {
    const chunk = byId.get(source.chunkId);
    if (!chunk) return [];
    return [
      {
        ...source,
        excerpt: chunk.content.slice(0, EXCERPT_LENGTH),
        score: chunk.vectorScore ?? null,
      },
    ];
  });
}

export function createChatResponder(
  chats: ChatRepository,
  {
    retriever,
    rewriter,
    model,
    providerOptions,
    relevanceThreshold = DEFAULT_RELEVANCE_THRESHOLD,
  }: ChatDeps,
  logger: Logger,
) {
  return {
    get available(): boolean {
      return model !== null;
    },

    async respond({
      chat,
      userId,
      question,
      signal,
    }: RespondInput): Promise<ReadableStream<UIMessageChunk>> {
      if (model === null) throw new Error('Chat model is not configured');

      const history = (await chats.messagesOf(chat.id)).map(({ role, content }) => ({
        role,
        content,
      }));
      await chats.addMessage({ chatId: chat.id, role: 'user', content: question });
      if (history.length === 0 && chat.title === DEFAULT_CHAT_TITLE) {
        await chats.rename(chat.id, userId, titleFromQuestion(question));
      }

      let sources: MessageSource[] = [];
      let retrieval: MessageRetrieval | undefined;

      const onError = (error: unknown): string => {
        logger.error({ err: error, chatId: chat.id }, 'chat answer failed');
        return chatFailureMessage(error);
      };

      return createUIMessageStream<ChatUIMessage>({
        onError,
        execute: async ({ writer }) => {
          writer.write({ type: 'start' });
          writer.write({ type: 'data-status', data: { stage: 'searching' }, transient: true });

          const rewritten = await rewriter.rewrite(history, question, { signal });
          const result = await retriever.retrieve(userId, rewritten.query);
          const relevance = assessRelevance(result.chunks, result.mode, relevanceThreshold);
          const details = {
            query: rewritten.query,
            rewritten: rewritten.rewritten,
            mode: result.mode,
            bestScore: relevance.bestScore,
          };

          if (!relevance.relevant) {
            retrieval = { ...details, outcome: 'declined' };
            logger.info(
              { chatId: chat.id, bestScore: relevance.bestScore, threshold: relevanceThreshold },
              'no relevant passages, answering without the model',
            );
            await chats.addMessage({
              chatId: chat.id,
              role: 'assistant',
              content: NO_ANSWER_MESSAGE,
              sources: [],
              retrieval,
            });
            writer.write({ type: 'data-sources', data: { sources: [], retrieval } });
            writer.write({ type: 'text-start', id: 'no-answer' });
            writer.write({ type: 'text-delta', id: 'no-answer', delta: NO_ANSWER_MESSAGE });
            writer.write({ type: 'text-end', id: 'no-answer' });
            writer.write({ type: 'finish', finishReason: 'stop' });
            return;
          }

          const prompt = buildChatPrompt({ question, history, chunks: result.chunks });
          sources = toMessageSources(prompt.sources, result.chunks);
          retrieval = { ...details, outcome: 'answered' };
          writer.write({ type: 'data-sources', data: { sources, retrieval } });
          writer.write({ type: 'data-status', data: { stage: 'answering' }, transient: true });

          const answer = streamText({
            model,
            system: prompt.system,
            messages: prompt.messages,
            temperature: 0.2,
            maxOutputTokens: MAX_ANSWER_TOKENS,
            maxRetries: 2,
            timeout: ANSWER_TIMEOUT,
            providerOptions,
            abortSignal: signal,
            onError: ({ error }) => logger.error({ err: error }, 'model stream error'),
          });
          writer.merge(toUIMessageStream({ stream: answer.stream, sendStart: false, onError }));
        },
        onEnd: async ({ responseMessage, finishReason, isAborted, isCancelled }) => {
          const finished = finishReason === 'stop' || finishReason === 'length';
          if (!finished || isAborted || isCancelled) return;
          if (retrieval?.outcome === 'declined') return;
          const text = responseMessage.parts
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('')
            .trim();
          if (text.length === 0) return;
          await chats.addMessage({
            chatId: chat.id,
            role: 'assistant',
            content: text,
            sources,
            retrieval,
          });
        },
      });
    },
  };
}

export type ChatResponder = ReturnType<typeof createChatResponder>;
