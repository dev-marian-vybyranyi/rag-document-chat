import type { UIMessage } from 'ai';

export interface ChatSource {
  id: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  ordinal: number;
  excerpt: string;
  score: number | null;
}

export interface ChatRetrieval {
  query: string;
  rewritten: boolean;
  mode: 'hybrid' | 'keyword-only';
  bestScore: number | null;
  outcome: 'answered' | 'declined';
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

export function sourcesOf(message: ChatUIMessage): ChatSource[] {
  for (const part of message.parts) {
    if (part.type === 'data-sources') return part.data.sources;
  }
  return [];
}
