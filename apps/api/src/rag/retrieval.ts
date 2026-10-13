import {
  and,
  arrayOverlaps,
  asc,
  cosineDistance,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chunks, documents } from '../db/schema.js';
import type { MeetingFacts, MeetingFilter } from '../meetings/question-filters.js';
import type { MeetingLocation } from '../meetings/types.js';
import type { CodeSource } from './code-source.js';
import { codeSearchTerms, toTsQueryOr } from './code-terms.js';

export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  page: number | null;
  code?: CodeSource;
  meeting?: MeetingLocation;
  content: string;
  score: number;
}

const PROSE_KINDS: Array<(typeof documents.kind.enumValues)[number]> = ['document', 'transcript'];

export interface SearchScope {
  documentIds?: string[];
  meeting?: MeetingFilter;
}

export interface RetrievalStore {
  meetingFacts(userId: string, scope?: SearchScope): Promise<MeetingFacts[]>;
  vectorSearch(
    userId: string,
    queryEmbedding: number[],
    limit: number,
    scope?: SearchScope,
  ): Promise<RetrievalCandidate[]>;
  keywordSearch(
    userId: string,
    queryText: string,
    limit: number,
    scope?: SearchScope,
  ): Promise<RetrievalCandidate[]>;
}

export function createRetrievalStore(
  db: Database,
  options: { embeddingModel?: string } = {},
): RetrievalStore {
  const sameModel = options.embeddingModel
    ? eq(documents.embeddingModel, options.embeddingModel)
    : undefined;

  const columns = {
    chunkId: chunks.id,
    documentId: chunks.documentId,
    filename: documents.filename,
    ordinal: chunks.ordinal,
    page: chunks.page,
    content: chunks.content,
    path: chunks.path,
    language: chunks.language,
    startLine: chunks.startLine,
    endLine: chunks.endLine,
    symbol: chunks.symbol,
    startMs: chunks.startMs,
    endMs: chunks.endMs,
    speakers: chunks.speakers,
  };

  function toCandidate<
    Row extends {
      path: string | null;
      language: string | null;
      startLine: number | null;
      endLine: number | null;
      symbol: string | null;
      startMs: number | null;
      endMs: number | null;
      speakers: string[] | null;
    },
  >({ path, language, startLine, endLine, symbol, startMs, endMs, speakers, ...rest }: Row) {
    const candidate: Omit<
      Row,
      'path' | 'language' | 'startLine' | 'endLine' | 'symbol' | 'startMs' | 'endMs' | 'speakers'
    > & { code?: CodeSource; meeting?: MeetingLocation } = rest;
    if (path !== null) candidate.code = { path, language, startLine, endLine, symbol };
    if (speakers !== null) candidate.meeting = { startMs, endMs, speakers };
    return candidate;
  }

  const inScope = (scope: SearchScope) =>
    scope.documentIds ? inArray(documents.id, scope.documentIds) : undefined;

  const meetingCondition = ({ meeting }: SearchScope) => {
    if (!meeting) return undefined;
    const kept = [];
    if (meeting.speakers.length > 0) kept.push(arrayOverlaps(chunks.speakers, meeting.speakers));
    if (meeting.windows.length > 0) {
      kept.push(
        or(
          notInArray(
            chunks.documentId,
            meeting.windows.map((window) => window.documentId),
          ),
          ...meeting.windows.map((window) =>
            and(
              eq(chunks.documentId, window.documentId),
              isNotNull(chunks.startMs),
              lte(chunks.startMs, window.toMs),
              gte(chunks.endMs, window.fromMs),
            ),
          ),
        )!,
      );
    }
    return kept.length === 0 ? undefined : or(ne(documents.kind, 'transcript'), and(...kept));
  };

  async function searchProse(userId: string, queryText: string, limit: number, scope: SearchScope) {
    const anyTerm = sql`replace(plainto_tsquery('english', ${queryText}::text)::text, ' & ', ' | ')::tsquery`;
    const rank = sql<number>`ts_rank(${chunks.searchVector}, ${anyTerm}, 32)`;

    const rows = await db
      .select({ ...columns, score: rank })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          eq(chunks.userId, userId),
          inArray(documents.kind, PROSE_KINDS),
          sameModel,
          inScope(scope),
          meetingCondition(scope),
          sql`${chunks.searchVector} @@ ${anyTerm}`,
        ),
      )
      .orderBy(desc(rank), asc(chunks.documentId), asc(chunks.ordinal))
      .limit(limit);
    return rows.map(toCandidate);
  }

  async function searchCode(userId: string, queryText: string, limit: number, scope: SearchScope) {
    const terms = codeSearchTerms(queryText);
    if (terms.length === 0) return [];
    const anyTerm = sql`to_tsquery('simple', ${toTsQueryOr(terms)})`;
    const rank = sql<number>`ts_rank(${chunks.codeSearchVector}, ${anyTerm}, 32)`;

    const rows = await db
      .select({ ...columns, score: rank })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          eq(chunks.userId, userId),
          eq(documents.kind, 'repository'),
          sameModel,
          inScope(scope),
          sql`${chunks.codeSearchVector} @@ ${anyTerm}`,
        ),
      )
      .orderBy(desc(rank), asc(chunks.documentId), asc(chunks.ordinal))
      .limit(limit);
    return rows.map(toCandidate);
  }

  return {
    async meetingFacts(userId, scope = {}) {
      if (scope.documentIds?.length === 0) return [];
      const rows = await db
        .select({
          id: documents.id,
          participants: documents.participants,
          durationMs: documents.durationMs,
          firstStartMs: sql<number | null>`min(${chunks.startMs})`,
        })
        .from(documents)
        .leftJoin(chunks, and(eq(chunks.documentId, documents.id), isNotNull(chunks.startMs)))
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.kind, 'transcript'),
            eq(documents.status, 'ready'),
            sameModel,
            inScope(scope),
          ),
        )
        .groupBy(documents.id);
      return rows.map((row) => ({
        id: row.id,
        participants: row.participants ?? [],
        firstStartMs: row.firstStartMs,
        endMs:
          row.firstStartMs === null || row.durationMs === null
            ? null
            : row.firstStartMs + row.durationMs,
      }));
    },

    async vectorSearch(userId, queryEmbedding, limit, scope = {}) {
      if (limit <= 0 || scope.documentIds?.length === 0) return [];
      const distance = cosineDistance(chunks.embedding, queryEmbedding);

      return db.transaction(async (tx) => {
        await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
        const rows = await tx
          .select({ ...columns, score: sql<number>`1 - (${distance})` })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(and(eq(chunks.userId, userId), sameModel, inScope(scope), meetingCondition(scope)))
          .orderBy(distance, asc(chunks.documentId), asc(chunks.ordinal))
          .limit(limit);
        return rows.map(toCandidate);
      });
    },

    async keywordSearch(userId, queryText, limit, scope = {}) {
      if (limit <= 0 || queryText.trim().length === 0 || scope.documentIds?.length === 0) return [];
      const [prose, code] = await Promise.all([
        searchProse(userId, queryText, limit, scope),
        searchCode(userId, queryText, limit, scope),
      ]);
      return [...prose, ...code].sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
