import type { UIMessageChunk } from 'ai';
import { inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { chunks } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import {
  CHAT_FAILURE_MESSAGES,
  failureKindOfMessage,
  type ChatFailureKind,
} from '../chat/errors.js';
import { createChatRepository } from '../chat/repository.js';
import { createChatResponder, type ChatDeps } from '../chat/responder.js';
import type { MessageRetrieval, MessageSource } from '../chat/types.js';
import type { TraceRecorder } from '../observability/traces.js';
import type { AskedAnswer, Asker } from './faithfulness-eval.js';
import { QuotaExhaustedError } from './quota-exhausted.js';

export const DEFAULT_ANSWER_PACING_MS = 4000;
export const DEFAULT_BUSY_RETRIES = 4;
export const DEFAULT_BUSY_WAIT_MS = 35_000;

const noTraces: TraceRecorder = { record: async () => {} };

const RETRYABLE_KINDS = new Set<ChatFailureKind | null>(['rate_limited', 'overloaded', 'timeout']);

export { QuotaExhaustedError };

interface AskerOptions {
  db: Database;
  userId: string;
  chat: ChatDeps;
  logger: Logger;
  pacingMs?: number;
  busyRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (ms: number, reason: string) => void;
}

interface Collected {
  text: string;
  sources: MessageSource[];
  retrieval: MessageRetrieval | null;
  error: string | null;
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<Collected> {
  const result: Collected = { text: '', sources: [], retrieval: null, error: null };
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return result;
    if (value.type === 'text-delta') result.text += value.delta;
    else if (value.type === 'error') result.error = value.errorText;
    else if (value.type === 'data-sources') {
      const data = value.data as { sources: MessageSource[]; retrieval: MessageRetrieval };
      result.sources = data.sources;
      result.retrieval = data.retrieval;
    }
  }
}

export function createResponderAsker({
  db,
  userId,
  chat,
  logger,
  pacingMs = DEFAULT_ANSWER_PACING_MS,
  busyRetries = DEFAULT_BUSY_RETRIES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWait,
}: AskerOptions): Asker {
  const chats = createChatRepository(db);
  const responder = createChatResponder(chats, chat, logger, noTraces);
  let lastCallAt = 0;

  async function attempt(question: Parameters<Asker['ask']>[0]): Promise<Collected> {
    const sinceLast = Date.now() - lastCallAt;
    if (sinceLast < pacingMs) await sleep(pacingMs - sinceLast);
    lastCallAt = Date.now();

    const conversation = await chats.create(userId, question.id);
    for (const turn of question.history ?? []) {
      await chats.addMessage({ chatId: conversation.id, role: turn.role, content: turn.content });
    }
    const stream = await responder.respond({
      chat: conversation,
      userId,
      question: question.question,
    });
    return collect(stream);
  }

  async function answerWithPatience(question: Parameters<Asker['ask']>[0]): Promise<Collected> {
    for (let tries = 0; ; tries++) {
      let collected: Collected;
      try {
        collected = await attempt(question);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'ai_busy')) throw error;
        if (error.message === CHAT_FAILURE_MESSAGES.quota_exhausted)
          throw new QuotaExhaustedError();
        await wait(
          error.retryAfterSeconds ? error.retryAfterSeconds * 1000 + 1000 : DEFAULT_BUSY_WAIT_MS,
          error.message,
          tries,
        );
        continue;
      }

      const failure = collected.error;
      const kind = failure === null ? null : failureKindOfMessage(failure);
      if (kind === 'quota_exhausted') throw new QuotaExhaustedError();
      if (failure === null || !RETRYABLE_KINDS.has(kind) || tries >= busyRetries) {
        return collected;
      }
      await wait(DEFAULT_BUSY_WAIT_MS, failure, tries);
    }
  }

  return {
    async ask(question): Promise<AskedAnswer> {
      const collected = await answerWithPatience(question);

      const content = await sourceContents(db, collected.sources);
      return {
        text: collected.text,
        sources: collected.sources.map((source) => ({
          id: source.id,
          filename: source.filename,
          page: source.page,
          content: content.get(source.chunkId) ?? source.excerpt,
        })),
        declined: collected.retrieval?.outcome === 'declined',
        error: collected.error,
      };
    },
  };

  async function wait(ms: number, reason: string, tries: number) {
    if (tries >= busyRetries) throw new Error(`Still busy after ${busyRetries} retries: ${reason}`);
    onWait?.(ms, reason);
    await sleep(ms);
  }
}

async function sourceContents(db: Database, sources: MessageSource[]) {
  if (sources.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: chunks.id, content: chunks.content })
    .from(chunks)
    .where(
      inArray(
        chunks.id,
        sources.map((source) => source.chunkId),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.content]));
}
