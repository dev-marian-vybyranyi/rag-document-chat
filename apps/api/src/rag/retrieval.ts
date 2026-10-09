import { and, asc, cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chunks, documents } from '../db/schema.js';
import type { CodeSource } from './code-source.js';
import { codeSearchTerms, toTsQueryOr } from './code-terms.js';

export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  page: number | null;
  code?: CodeSource;
  content: string;
  score: number;
}

export interface RetrievalStore {
  vectorSearch(
    userId: string,
    queryEmbedding: number[],
    limit: number,
  ): Promise<RetrievalCandidate[]>;
  keywordSearch(userId: string, queryText: string, limit: number): Promise<RetrievalCandidate[]>;
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
  };

  function toCandidate<
    Row extends {
      path: string | null;
      language: string | null;
      startLine: number | null;
      endLine: number | null;
      symbol: string | null;
    },
  >({ path, language, startLine, endLine, symbol, ...rest }: Row) {
    const candidate: Omit<Row, 'path' | 'language' | 'startLine' | 'endLine' | 'symbol'> & {
      code?: CodeSource;
    } = rest;
    if (path !== null) candidate.code = { path, language, startLine, endLine, symbol };
    return candidate;
  }

  async function searchProse(userId: string, queryText: string, limit: number) {
    const anyTerm = sql`replace(plainto_tsquery('english', ${queryText}::text)::text, ' & ', ' | ')::tsquery`;
    const rank = sql<number>`ts_rank(${chunks.searchVector}, ${anyTerm}, 32)`;

    const rows = await db
      .select({ ...columns, score: rank })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          eq(chunks.userId, userId),
          eq(documents.kind, 'document'),
          sameModel,
          sql`${chunks.searchVector} @@ ${anyTerm}`,
        ),
      )
      .orderBy(desc(rank), asc(chunks.documentId), asc(chunks.ordinal))
      .limit(limit);
    return rows.map(toCandidate);
  }

  async function searchCode(userId: string, queryText: string, limit: number) {
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
          sql`${chunks.codeSearchVector} @@ ${anyTerm}`,
        ),
      )
      .orderBy(desc(rank), asc(chunks.documentId), asc(chunks.ordinal))
      .limit(limit);
    return rows.map(toCandidate);
  }

  return {
    async vectorSearch(userId, queryEmbedding, limit) {
      if (limit <= 0) return [];
      const distance = cosineDistance(chunks.embedding, queryEmbedding);

      return db.transaction(async (tx) => {
        await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
        const rows = await tx
          .select({ ...columns, score: sql<number>`1 - (${distance})` })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(and(eq(chunks.userId, userId), sameModel))
          .orderBy(distance, asc(chunks.documentId), asc(chunks.ordinal))
          .limit(limit);
        return rows.map(toCandidate);
      });
    },

    async keywordSearch(userId, queryText, limit) {
      if (limit <= 0 || queryText.trim().length === 0) return [];
      const [prose, code] = await Promise.all([
        searchProse(userId, queryText, limit),
        searchCode(userId, queryText, limit),
      ]);
      return [...prose, ...code].sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}
