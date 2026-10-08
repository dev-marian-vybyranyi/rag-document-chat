import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { ragTraces } from '../db/schema.js';
import type { RagTrace } from './types.js';

export interface TraceRecorder {
  record(trace: RagTrace): Promise<void>;
}

export function createTraceRecorder(db: Database, logger: Logger): TraceRecorder {
  return {
    async record(trace) {
      logger.info(
        {
          chatId: trace.chatId,
          outcome: trace.outcome,
          mode: trace.retrievalMode,
          bestScore: trace.bestScore,
          retrieved: trace.retrieved.length,
          rewriteMs: trace.rewriteMs,
          retrievalMs: trace.retrievalMs,
          generationMs: trace.generationMs,
          totalMs: trace.totalMs,
          inputTokens: trace.inputTokens,
          outputTokens: trace.outputTokens,
          citationsKept: trace.citationsKept,
          citationsRemoved: trace.citationsRemoved,
          model: trace.model,
          errorKind: trace.errorKind,
        },
        'rag trace',
      );
      try {
        await db.insert(ragTraces).values(trace);
      } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
        logger.error(
          { chatId: trace.chatId, reason: cause instanceof Error ? cause.message : 'unknown' },
          'could not store rag trace',
        );
      }
    },
  };
}
