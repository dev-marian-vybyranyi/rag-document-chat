import type { Logger } from 'pino';
import type { Embedder } from '../ai/embeddings.js';
import type { AppliedFilters } from '../meetings/question-filters.js';
import { assessRelevance } from '../rag/relevance.js';
import type { RetrievalCandidate, RetrievalStore } from '../rag/retrieval.js';
import { createRetriever } from '../rag/retriever.js';
import {
  isSpoken,
  QUESTION_KINDS,
  type GoldenMeetings,
  type MeetingAnswerable,
  type MeetingEvidence,
} from './golden-meetings.js';
import {
  firstRelevantRank,
  summarizeRanks,
  sweepThresholds,
  type RankSummary,
  type ThresholdPoint,
} from './metrics.js';
import { createPatientEmbedder, type PatienceOptions } from './patient-embedder.js';

export const MEETING_VARIANTS = ['hybrid', 'unfiltered', 'vector', 'keyword'] as const;
export type MeetingVariant = (typeof MEETING_VARIANTS)[number];
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const MEETING_CUTOFF = 6;
export const MEETING_KS = [1, 3, 6];
export const MEETING_THRESHOLDS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];

export interface MeetingHit {
  file: string;
  startMs: number | null;
  endMs: number | null;
  speakers: string[];
  content: string;
}

export interface MeetingSearchOutcome {
  hits: MeetingHit[];
  bestScore: number | null;
  filters?: AppliedFilters;
}

export interface MeetingSearcher {
  search(variant: MeetingVariant, query: string, scope?: string[]): Promise<MeetingSearchOutcome>;
}

export function isRelevantHit(hit: MeetingHit, expected: MeetingEvidence[]): boolean {
  return expected.some((evidence) => {
    if (hit.file !== evidence.meeting) return false;
    if (!isSpoken(evidence)) return hit.startMs === null;
    return (
      hit.startMs !== null &&
      hit.endMs !== null &&
      hit.startMs <= evidence.atMs &&
      evidence.atMs <= hit.endMs
    );
  });
}

export interface FilterCheck {
  expected: { speakers: string[]; time: string | null } | null;
  actual: { speakers: string[]; time: string | null; relaxed: boolean } | null;
  agrees: boolean;
}

export interface MeetingRow {
  id: string;
  kind: QuestionKind;
  question: string;
  ranks: Record<MeetingVariant, number | null>;
  hybridTop: Array<{ file: string; startMs: number | null; relevant: boolean }>;
  bestScore: number | null;
  filters: FilterCheck;
}

export interface MeetingUnansweredRow {
  id: string;
  question: string;
  hard: boolean;
  bestScore: number | null;
}

export interface MeetingRetrievalReport {
  cutoff: number;
  ks: number[];
  summary: {
    all: Record<MeetingVariant, RankSummary>;
    byKind: Record<QuestionKind, Record<MeetingVariant, RankSummary>>;
  };
  filters: { named: number; recognised: number; unexpected: number; relaxed: number };
  rows: MeetingRow[];
  unanswerable: MeetingUnansweredRow[];
  thresholds: ThresholdPoint[];
}

export interface MeetingEvalOptions {
  golden: GoldenMeetings;
  searcher: MeetingSearcher;
  cutoff?: number;
  ks?: number[];
  thresholds?: number[];
  onProgress?: (done: number, total: number, id: string) => void;
}

const sorted = (names: string[]) => [...names].sort();

export function checkFilters(
  question: MeetingAnswerable,
  applied: AppliedFilters | undefined,
): FilterCheck {
  const wanted = question.filters;
  const expected = wanted
    ? { speakers: sorted(wanted.speakers ?? []), time: wanted.time ?? null }
    : null;
  const actual = applied
    ? { speakers: sorted(applied.speakers), time: applied.time, relaxed: applied.relaxed }
    : null;
  const agrees =
    expected === null
      ? actual === null
      : actual !== null &&
        JSON.stringify(expected.speakers) === JSON.stringify(actual.speakers) &&
        expected.time === actual.time;
  return { expected, actual, agrees };
}

export async function evaluateMeetingRetrieval({
  golden,
  searcher,
  cutoff = MEETING_CUTOFF,
  ks = MEETING_KS,
  thresholds = MEETING_THRESHOLDS,
  onProgress,
}: MeetingEvalOptions): Promise<MeetingRetrievalReport> {
  const rows: MeetingRow[] = [];
  const unanswerable: MeetingUnansweredRow[] = [];
  let done = 0;

  for (const question of golden.questions) {
    const hybrid = await searcher.search('hybrid', question.question, question.scope);
    if (question.type === 'unanswerable') {
      unanswerable.push({
        id: question.id,
        question: question.question,
        hard: question.hard ?? false,
        bestScore: hybrid.bestScore,
      });
    } else {
      const rankOf = (hits: MeetingHit[]) =>
        firstRelevantRank(
          hits.slice(0, cutoff).map((hit) => isRelevantHit(hit, question.expected)),
        );
      const [unfiltered, vector, keyword] = [
        await searcher.search('unfiltered', question.question, question.scope),
        await searcher.search('vector', question.question, question.scope),
        await searcher.search('keyword', question.question, question.scope),
      ];
      rows.push({
        id: question.id,
        kind: question.kind,
        question: question.question,
        ranks: {
          hybrid: rankOf(hybrid.hits),
          unfiltered: rankOf(unfiltered.hits),
          vector: rankOf(vector.hits),
          keyword: rankOf(keyword.hits),
        },
        hybridTop: hybrid.hits.slice(0, cutoff).map((hit) => ({
          file: hit.file,
          startMs: hit.startMs,
          relevant: isRelevantHit(hit, question.expected),
        })),
        bestScore: hybrid.bestScore,
        filters: checkFilters(question, hybrid.filters),
      });
    }
    onProgress?.(++done, golden.questions.length, question.id);
  }

  const summarize = (subset: MeetingRow[]) =>
    Object.fromEntries(
      MEETING_VARIANTS.map((variant) => [
        variant,
        summarizeRanks(
          subset.map((row) => row.ranks[variant]),
          ks,
        ),
      ]),
    ) as Record<MeetingVariant, RankSummary>;

  const named = rows.filter((row) => row.filters.expected !== null);
  return {
    cutoff,
    ks,
    summary: {
      all: summarize(rows),
      byKind: Object.fromEntries(
        QUESTION_KINDS.map((kind) => [kind, summarize(rows.filter((row) => row.kind === kind))]),
      ) as Record<QuestionKind, Record<MeetingVariant, RankSummary>>,
    },
    filters: {
      named: named.length,
      recognised: named.filter((row) => row.filters.agrees).length,
      unexpected: rows.filter((row) => row.filters.expected === null && row.filters.actual !== null)
        .length,
      relaxed: rows.filter((row) => row.filters.actual?.relaxed === true).length,
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

interface SearcherDeps extends PatienceOptions {
  userId: string;
  store: RetrievalStore;
  embedder: Embedder;
  logger: Logger;
  documents: Map<string, string>;
  cutoff?: number;
}

export function createMeetingSearcher({
  userId,
  store,
  embedder,
  logger,
  documents,
  cutoff = MEETING_CUTOFF,
  ...patience
}: SearcherDeps): MeetingSearcher {
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
  const filtered = createRetriever({ store, embedder: cachedEmbedder, logger });
  const plain = createRetriever({
    store: { ...store, meetingFacts: async () => [] },
    embedder: cachedEmbedder,
    logger,
  });
  const files = new Map([...documents].map(([file, id]) => [id, file]));

  const toHit = (candidate: RetrievalCandidate): MeetingHit => ({
    file: files.get(candidate.documentId) ?? candidate.filename,
    startMs: candidate.meeting?.startMs ?? null,
    endMs: candidate.meeting?.endMs ?? null,
    speakers: candidate.meeting?.speakers ?? [],
    content: candidate.content,
  });
  const idsOf = (scope?: string[]) =>
    scope ? scope.map((file) => documents.get(file)!) : undefined;

  return {
    async search(variant, query, scope) {
      const documentIds = idsOf(scope);
      if (variant === 'hybrid' || variant === 'unfiltered') {
        const retriever = variant === 'hybrid' ? filtered : plain;
        const result = await retriever.retrieve(userId, query, {
          limit: cutoff,
          ...(documentIds && { documentIds }),
        });
        if (result.mode === 'keyword-only') {
          throw new Error(
            `The query could not be embedded, so the result for "${query}" would measure keyword search only`,
          );
        }
        return {
          hits: result.chunks.map(toHit),
          bestScore: assessRelevance(result.chunks, result.mode, 0).bestScore,
          ...(result.filters && { filters: result.filters }),
        };
      }
      const scopeOf = documentIds ? { documentIds } : {};
      if (variant === 'vector') {
        const vector = await cachedEmbedder.embedQuery(query);
        const found = await store.vectorSearch(userId, vector, cutoff, scopeOf);
        return { hits: found.map(toHit), bestScore: found[0]?.score ?? null };
      }
      const found = await store.keywordSearch(userId, query, cutoff, scopeOf);
      return { hits: found.map(toHit), bestScore: null };
    },
  };
}
