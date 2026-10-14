import type { AppliedFilters } from '../meetings/question-filters.js';
import type { MeetingLocation } from '../meetings/types.js';
import type { CareerSource } from '../rag/career-source.js';
import type { CodeSource } from '../rag/code-source.js';

export interface MessageSource {
  id: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  code?: CodeSource;
  meeting?: MeetingLocation;
  career?: CareerSource;
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
  meeting?: MeetingLocation;
  career?: CareerSource;
  score: number;
}

export interface MessageRetrieval {
  query: string;
  rewritten: boolean;
  mode: 'hybrid' | 'keyword-only';
  bestScore: number | null;
  threshold: number;
  filters?: AppliedFilters;
  outcome: 'answered' | 'declined';
  timings: { rewriteMs: number; retrievalMs: number };
  closest: ClosestPassage[];
}
