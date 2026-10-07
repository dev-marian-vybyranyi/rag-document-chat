import {
  createUIMessageStream,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import type { Logger } from 'pino';
import { buildChatPrompt, NO_ANSWER_PREFIX, type PromptSource } from '../rag/prompt.js';
import { assessRelevance, DEFAULT_RELEVANCE_THRESHOLD } from '../rag/relevance.js';
import type { RetrievedChunk } from '../rag/fusion.js';
import type { QueryRewriter } from '../rag/rewrite.js';
import type { Retriever } from '../rag/retriever.js';
import type { TraceRecorder } from '../observability/traces.js';
import type { RagTrace, TracedChunk } from '../observability/types.js';
import { CHAT_FAILURE_MESSAGES, classifyChatFailure } from './errors.js';
import { DEFAULT_CHAT_TITLE, type ChatRecord, type ChatRepository } from './repository.js';
import type { ClosestPassage, MessageRetrieval, MessageSource } from './types.js';

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

export const CLOSEST_PASSAGES = 3;

export function closestPassages(chunks: RetrievedChunk[]): ClosestPassage[] {
  return chunks
    .flatMap((chunk) =>
      typeof chunk.vectorScore === 'number'
        ? [{ filename: chunk.filename, page: chunk.page, score: chunk.vectorScore }]
        : [],
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, CLOSEST_PASSAGES);
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
        vectorRank: chunk.vectorRank,
        keywordScore: chunk.keywordScore,
        keywordRank: chunk.keywordRank,
        fusedScore: chunk.score,
      },
    ];
  });
}

export function toTracedChunks(chunks: RetrievedChunk[], sentIds: Set<string>): TracedChunk[] {
  return chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    filename: chunk.filename,
    page: chunk.page,
    ordinal: chunk.ordinal,
    vectorScore: chunk.vectorScore,
    vectorRank: chunk.vectorRank,
    keywordScore: chunk.keywordScore,
    keywordRank: chunk.keywordRank,
    fusedScore: chunk.score,
    sentToModel: sentIds.has(chunk.chunkId),
  }));
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
  traces: TraceRecorder,
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

      const startedAt = Date.now();
      const modelId = typeof model === 'string' ? model : model.modelId;
      let progress: Partial<RagTrace> = {};
      let answerStartedAt: number | undefined;
      let totalUsage: PromiseLike<LanguageModelUsage> | undefined;
      let recorded = false;

      const record = async (fields: Pick<RagTrace, 'outcome'> & Partial<RagTrace>) => {
        if (recorded) return;
        recorded = true;
        await traces.record({
          userId,
          chatId: chat.id,
          messageId: null,
          question,
          rewrittenQuery: null,
          retrievalMode: null,
          bestScore: null,
          threshold: null,
          retrieved: [],
          rewriteMs: null,
          retrievalMs: null,
          generationMs: answerStartedAt === undefined ? null : Date.now() - answerStartedAt,
          inputTokens: null,
          outputTokens: null,
          model: modelId,
          errorKind: null,
          ...progress,
          ...fields,
          totalMs: Date.now() - startedAt,
        });
      };

      const tokensUsed = async () => {
        try {
          const usage = await totalUsage;
          return {
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
          };
        } catch {
          return { inputTokens: null, outputTokens: null };
        }
      };

      const onError = (error: unknown): string => {
        logger.error({ err: error, chatId: chat.id }, 'chat answer failed');
        const kind = classifyChatFailure(error);
        void record({ outcome: kind === 'cancelled' ? 'cancelled' : 'failed', errorKind: kind });
        return CHAT_FAILURE_MESSAGES[kind];
      };

      return createUIMessageStream<ChatUIMessage>({
        onError,
        execute: async ({ writer }) => {
          writer.write({ type: 'start' });
          writer.write({ type: 'data-status', data: { stage: 'searching' }, transient: true });

          const rewriteStart = Date.now();
          const rewritten = await rewriter.rewrite(history, question, { signal });
          const retrievalStart = Date.now();
          const result = await retriever.retrieve(userId, rewritten.query);
          const relevance = assessRelevance(result.chunks, result.mode, relevanceThreshold);
          const details = {
            query: rewritten.query,
            rewritten: rewritten.rewritten,
            mode: result.mode,
            bestScore: relevance.bestScore,
            threshold: relevanceThreshold,
            timings: {
              rewriteMs: retrievalStart - rewriteStart,
              retrievalMs: Date.now() - retrievalStart,
            },
          };

          progress = {
            rewrittenQuery: details.query,
            retrievalMode: result.mode,
            bestScore: relevance.bestScore,
            threshold: relevanceThreshold,
            rewriteMs: details.timings.rewriteMs,
            retrievalMs: details.timings.retrievalMs,
            retrieved: toTracedChunks(result.chunks, new Set()),
          };

          if (!relevance.relevant) {
            retrieval = {
              ...details,
              outcome: 'declined',
              closest: closestPassages(result.chunks),
            };
            logger.info(
              { chatId: chat.id, bestScore: relevance.bestScore, threshold: relevanceThreshold },
              'no relevant passages, answering without the model',
            );
            const declined = await chats.addMessage({
              chatId: chat.id,
              role: 'assistant',
              content: NO_ANSWER_MESSAGE,
              sources: [],
              retrieval,
            });
            await record({ outcome: 'declined', messageId: declined.id });
            writer.write({ type: 'data-sources', data: { sources: [], retrieval } });
            writer.write({ type: 'text-start', id: 'no-answer' });
            writer.write({ type: 'text-delta', id: 'no-answer', delta: NO_ANSWER_MESSAGE });
            writer.write({ type: 'text-end', id: 'no-answer' });
            writer.write({ type: 'finish', finishReason: 'stop' });
            return;
          }

          const prompt = buildChatPrompt({ question, history, chunks: result.chunks });
          sources = toMessageSources(prompt.sources, result.chunks);
          retrieval = { ...details, outcome: 'answered', closest: [] };
          progress.retrieved = toTracedChunks(
            result.chunks,
            new Set(sources.map((source) => source.chunkId)),
          );
          writer.write({ type: 'data-sources', data: { sources, retrieval } });
          writer.write({ type: 'data-status', data: { stage: 'answering' }, transient: true });
          answerStartedAt = Date.now();

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
          totalUsage = answer.totalUsage;
          writer.merge(toUIMessageStream({ stream: answer.stream, sendStart: false, onError }));
        },
        onEnd: async ({ responseMessage, finishReason, isAborted, isCancelled }) => {
          if (retrieval?.outcome === 'declined') return;
          if (isAborted || isCancelled) {
            await record({ outcome: 'cancelled' });
            return;
          }
          const finished = finishReason === 'stop' || finishReason === 'length';
          const text = responseMessage.parts
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('')
            .trim();
          if (!finished || text.length === 0) {
            await record({ outcome: 'failed', errorKind: 'unexpected' });
            return;
          }
          const saved = await chats.addMessage({
            chatId: chat.id,
            role: 'assistant',
            content: text,
            sources,
            retrieval,
          });
          await record({ outcome: 'answered', messageId: saved.id, ...(await tokensUsed()) });
        },
      });
    },
  };
}

export type ChatResponder = ReturnType<typeof createChatResponder>;
