import type { UIMessage } from 'ai';
import type { CodeLocation, MeetingLocation } from '../documents/api';

export interface ChatSource {
  id: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  code?: CodeLocation;
  meeting?: MeetingLocation;
  ordinal: number;
  excerpt: string;
  score: number | null;
  vectorRank?: number | null;
  keywordScore?: number | null;
  keywordRank?: number | null;
  fusedScore?: number;
}

export interface ChatRetrieval {
  query: string;
  rewritten: boolean;
  mode: 'hybrid' | 'keyword-only';
  bestScore: number | null;
  outcome: 'answered' | 'declined';
  threshold?: number;
  filters?: { speakers: string[]; time: string | null; relaxed: boolean };
  timings?: { rewriteMs: number; retrievalMs: number };
  closest?: Array<{
    filename: string;
    page: number | null;
    code?: CodeLocation;
    meeting?: MeetingLocation;
    score: number;
  }>;
}

export type ChatStage = 'searching' | 'answering';

export type ChatUIMessage = UIMessage<
  never,
  {
    status: { stage: ChatStage };
    sources: { sources: ChatSource[]; retrieval: ChatRetrieval };
  }
>;

export function textOf(message: ChatUIMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

export function retrievalOf(message: ChatUIMessage): ChatRetrieval | null {
  for (const part of message.parts) {
    if (part.type === 'data-sources') return part.data.retrieval;
  }
  return null;
}

export function sourcesOf(message: ChatUIMessage): ChatSource[] {
  for (const part of message.parts) {
    if (part.type === 'data-sources') return part.data.sources;
  }
  return [];
}
