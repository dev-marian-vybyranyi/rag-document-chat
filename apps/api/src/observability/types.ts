import type { ChatFailureKind } from '../chat/errors.js';

export type TraceOutcome = 'answered' | 'declined' | 'failed' | 'cancelled';

export interface TracedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  ordinal: number;
  vectorScore: number | null;
  vectorRank: number | null;
  keywordScore: number | null;
  keywordRank: number | null;
  fusedScore: number;
  sentToModel: boolean;
}

export interface RagTrace {
  userId: string;
  chatId: string;
  messageId: string | null;
  outcome: TraceOutcome;
  question: string;
  rewrittenQuery: string | null;
  retrievalMode: 'hybrid' | 'keyword-only' | null;
  bestScore: number | null;
  threshold: number | null;
  retrieved: TracedChunk[];
  rewriteMs: number | null;
  retrievalMs: number | null;
  generationMs: number | null;
  totalMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  errorKind: ChatFailureKind | null;
}
