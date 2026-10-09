import type { CodeSource } from '../rag/code-source.js';

export interface MessageSource {
  id: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  code?: CodeSource;
  ordinal: number;
  excerpt: string;
  score: number | null;
  vectorRank: number | null;
  keywordScore: number | null;
  keywordRank: number | null;
  fusedScore: number;
}

export interface ClosestPassage {
  filename: string;
  page: number | null;
  code?: CodeSource;
  score: number;
}

export interface MessageRetrieval {
  query: string;
  rewritten: boolean;
  mode: 'hybrid' | 'keyword-only';
  bestScore: number | null;
  threshold: number;
  outcome: 'answered' | 'declined';
  timings: { rewriteMs: number; retrievalMs: number };
  closest: ClosestPassage[];
}
