export interface MessageSource {
  id: number;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  ordinal: number;
  excerpt: string;
  score: number | null;
}

export interface MessageRetrieval {
  query: string;
  rewritten: boolean;
  mode: 'hybrid' | 'keyword-only';
  bestScore: number | null;
  outcome: 'answered' | 'declined';
}
