import type { Logger } from 'pino';
import type { Embedder } from '../ai/embeddings.js';
import type { ChatTurn } from '../rag/history.js';
import { assessRelevance } from '../rag/relevance.js';
import type { RetrievalStore } from '../rag/retrieval.js';
import { createRetriever } from '../rag/retriever.js';
import type { QueryRewriter } from '../rag/rewrite.js';
import {
  containsQuote,
  type AnswerableQuestion,
  type GoldenExpected,
  type GoldenSet,
} from './golden.js';
import {
  firstRelevantRank,
  summarizeRanks,
  sweepThresholds,
  type RankSummary,
  type ThresholdPoint,
} from './metrics.js';
import { createPatientEmbedder, type PatienceOptions } from './patient-embedder.js';

export const VARIANTS = ['hybrid', 'vector', 'keyword'] as const;
export type Variant = (typeof VARIANTS)[number];

export const DEFAULT_CUTOFF = 6;
export const DEFAULT_KS = [1, 3, 6];
export const DEFAULT_THRESHOLDS = [
  0.5, 0.55, 0.6, 0.62, 0.64, 0.65, 0.66, 0.68, 0.7, 0.72, 0.75, 0.8,
];

export interface EvalHit {
  filename: string;
  page: number | null;
  content: string;
}

export interface SearchOutcome {
  hits: EvalHit[];
  bestScore: number | null;
}

export interface Searcher {
  rewrite(history: ChatTurn[], question: string): Promise<{ query: string; rewritten: boolean }>;
  search(variant: Variant, query: string): Promise<SearchOutcome>;
}

export function isRelevant(hit: EvalHit, expected: GoldenExpected[]): boolean {
  return expected.some((e) => e.file === hit.filename && containsQuote(hit.content, e.quote));
}

export interface QuestionRow {
  id: string;
  question: string;
  query: string;
  rewritten: boolean;
  followUp: boolean;
  ranks: Record<Variant, number | null>;
  hybridTop: Array<{ filename: string; page: number | null; relevant: boolean }>;
  bestScore: number | null;
}

export interface UnansweredRow {
  id: string;
  question: string;
  query: string;
  hard: boolean;
  bestScore: number | null;
}

export interface RetrievalReport {
  cutoff: number;
  ks: number[];
  rewrite: boolean;
  summary: {
    all: Record<Variant, RankSummary>;
    standalone: Record<Variant, RankSummary>;
    followUps: Record<Variant, RankSummary>;
  };
  rows: QuestionRow[];
  unanswerable: UnansweredRow[];
  thresholds: ThresholdPoint[];
}

export interface EvalOptions {
  golden: GoldenSet;
  searcher: Searcher;
  cutoff?: number;
  ks?: number[];
  rewrite?: boolean;
  thresholds?: number[];
  onProgress?: (done: number, total: number, id: string) => void;
}

export async function evaluateRetrieval({
  golden,
  searcher,
  cutoff = DEFAULT_CUTOFF,
  ks = DEFAULT_KS,
  rewrite = true,
  thresholds = DEFAULT_THRESHOLDS,
  onProgress,
}: EvalOptions): Promise<RetrievalReport> {
  const rows: QuestionRow[] = [];
  const unanswerable: UnansweredRow[] = [];
  let done = 0;

  for (const question of golden.questions) {
    const history = question.history ?? [];
    const rewritten =
      rewrite && history.length > 0
        ? await searcher.rewrite(history, question.question)
        : { query: question.question, rewritten: false };

    const hybrid = await searcher.search('hybrid', rewritten.query);

    if (question.type === 'unanswerable') {
      unanswerable.push({
        id: question.id,
        question: question.question,
        query: rewritten.query,
        hard: question.hard ?? false,
        bestScore: hybrid.bestScore,
      });
    } else {
      rows.push(await answerableRow(question, rewritten, hybrid, searcher, cutoff));
    }
    onProgress?.(++done, golden.questions.length, question.id);
  }

  const summarize = (subset: QuestionRow[]) =>
    Object.fromEntries(
      VARIANTS.map((variant) => [
        variant,
        summarizeRanks(
          subset.map((row) => row.ranks[variant]),
          ks,
        ),
      ]),
    ) as Record<Variant, RankSummary>;

  return {
    cutoff,
    ks,
    rewrite,
    summary: {
      all: summarize(rows),
      standalone: summarize(rows.filter((row) => !row.followUp)),
      followUps: summarize(rows.filter((row) => row.followUp)),
    },
    rows,
    unanswerable,
    thresholds: sweepThresholds(
      rows.map((row) => row.bestScore),
      unanswerable.map((row) => row.bestScore),
      thresholds,
    ),
  };
}

async function answerableRow(
  question: AnswerableQuestion,
  rewritten: { query: string; rewritten: boolean },
  hybrid: SearchOutcome,
  searcher: Searcher,
  cutoff: number,
): Promise<QuestionRow> {
  const rankOf = (hits: EvalHit[]) =>
    firstRelevantRank(hits.slice(0, cutoff).map((hit) => isRelevant(hit, question.expected)));

  const vector = await searcher.search('vector', rewritten.query);
  const keyword = await searcher.search('keyword', rewritten.query);

  return {
    id: question.id,
    question: question.question,
    query: rewritten.query,
    rewritten: rewritten.rewritten,
    followUp: (question.history?.length ?? 0) > 0,
    ranks: {
      hybrid: rankOf(hybrid.hits),
      vector: rankOf(vector.hits),
      keyword: rankOf(keyword.hits),
    },
    hybridTop: hybrid.hits.slice(0, cutoff).map((hit) => ({
      filename: hit.filename,
      page: hit.page,
      relevant: isRelevant(hit, question.expected),
    })),
    bestScore: hybrid.bestScore,
  };
}

interface SearcherDeps extends PatienceOptions {
  userId: string;
  store: RetrievalStore;
  embedder: Embedder;
  rewriter: QueryRewriter;
  logger: Logger;
  cutoff?: number;
}

export function createRetrievalSearcher({
  userId,
  store,
  embedder,
  rewriter,
  logger,
  cutoff = DEFAULT_CUTOFF,
  ...patience
}: SearcherDeps): Searcher {
  const patient = createPatientEmbedder(embedder, patience);
  const cache = new Map<string, Promise<number[]>>();
  const cachedEmbedder: Embedder = {
    embedDocuments: (texts, options) => patient.embedDocuments(texts, options),
    embedQuery: (text, options) => {
      const known = cache.get(text);
      if (known) return known;
      const pending = patient.embedQuery(text, options);
      cache.set(text, pending);
      pending.catch(() => cache.delete(text));
      return pending;
    },
  };
  const retriever = createRetriever({ store, embedder: cachedEmbedder, logger });
  const toHit = (c: {
    filename: string;
    page: number | null;
    content: string;
    code?: { path: string };
  }): EvalHit => ({
    filename: c.code?.path ?? c.filename,
    page: c.page,
    content: c.content,
  });

  return {
    rewrite: (history, question) => rewriter.rewrite(history, question),
    async search(variant, query) {
      if (variant === 'hybrid') {
        const result = await retriever.retrieve(userId, query, { limit: cutoff });
        if (result.mode === 'keyword-only') {
          throw new Error(
            `The query could not be embedded, so the result for "${query}" would measure keyword search only`,
          );
        }
        return {
          hits: result.chunks.map(toHit),
          bestScore: assessRelevance(result.chunks, result.mode).bestScore,
        };
      }
      if (variant === 'vector') {
        const vector = await cachedEmbedder.embedQuery(query);
        const found = await store.vectorSearch(userId, vector, cutoff);
        return { hits: found.map(toHit), bestScore: found[0]?.score ?? null };
      }
      const found = await store.keywordSearch(userId, query, cutoff);
      return { hits: found.map(toHit), bestScore: null };
    },
  };
}

export interface UncoveredQuote {
  id: string;
  file: string;
  quote: string;
}

export function findUncoveredQuotes(
  golden: GoldenSet,
  passagesByFile: Map<string, string[]>,
): UncoveredQuote[] {
  const uncovered: UncoveredQuote[] = [];
  for (const question of golden.questions) {
    if (question.type !== 'answerable') continue;
    const covered = question.expected.some((e) =>
      (passagesByFile.get(e.file) ?? []).some((passage) => containsQuote(passage, e.quote)),
    );
    if (!covered) {
      const first = question.expected[0]!;
      uncovered.push({ id: question.id, file: first.file, quote: first.quote });
    }
  }
  return uncovered;
}
