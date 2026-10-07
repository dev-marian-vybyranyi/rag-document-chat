import { and, asc, cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chunks, documents } from '../db/schema.js';

export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  filename: string;
  ordinal: number;
  page: number | null;
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

export function createRetrievalStore(db: Database): RetrievalStore {
  const columns = {
    chunkId: chunks.id,
    documentId: chunks.documentId,
    filename: documents.filename,
    ordinal: chunks.ordinal,
    page: chunks.page,
    content: chunks.content,
  };

  return {
    async vectorSearch(userId, queryEmbedding, limit) {
      if (limit <= 0) return [];
      const distance = cosineDistance(chunks.embedding, queryEmbedding);

      return db.transaction(async (tx) => {
        await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
        return tx
          .select({ ...columns, score: sql<number>`1 - (${distance})` })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.documentId))
          .where(eq(chunks.userId, userId))
          .orderBy(distance, asc(chunks.documentId), asc(chunks.ordinal))
          .limit(limit);
      });
    },

    async keywordSearch(userId, queryText, limit) {
      if (limit <= 0 || queryText.trim().length === 0) return [];
      const anyTerm = sql`replace(plainto_tsquery('english', ${queryText}::text)::text, ' & ', ' | ')::tsquery`;
      const rank = sql<number>`ts_rank(${chunks.searchVector}, ${anyTerm}, 32)`;

      return db
        .select({ ...columns, score: rank })
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.documentId))
        .where(and(eq(chunks.userId, userId), sql`${chunks.searchVector} @@ ${anyTerm}`))
        .orderBy(desc(rank), asc(chunks.documentId), asc(chunks.ordinal))
        .limit(limit);
    },
  };
}
