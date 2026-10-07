import { and, asc, desc, eq, getTableColumns, gte, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chunks, documents } from '../db/schema.js';

export type DocumentRecord = typeof documents.$inferSelect;

export type DocumentWithChunkCount = DocumentRecord & { chunkCount: number };

export interface NewChunk {
  ordinal: number;
  page: number | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export interface Passage {
  ordinal: number;
  page: number | null;
  content: string;
}

const CHUNK_INSERT_BATCH_SIZE = 100;

const chunkCountOf = sql<number>`(select count(*)::int from "chunks" c where c."document_id" = "documents"."id")`;

export function createDocumentRepository(db: Database) {
  return {
    async create(input: {
      userId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }): Promise<DocumentRecord> {
      const [document] = await db.insert(documents).values(input).returning();
      return document!;
    },

    async listByUser(userId: string): Promise<DocumentWithChunkCount[]> {
      return db
        .select({ ...getTableColumns(documents), chunkCount: chunkCountOf })
        .from(documents)
        .where(eq(documents.userId, userId))
        .orderBy(desc(documents.createdAt), desc(documents.id));
    },

    async findForUser(id: string, userId: string): Promise<DocumentWithChunkCount | undefined> {
      const [document] = await db
        .select({ ...getTableColumns(documents), chunkCount: chunkCountOf })
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.userId, userId)));
      return document;
    },

    async passagesAround(
      id: string,
      userId: string,
      ordinal: number,
      radius: number,
    ): Promise<{ document: DocumentRecord; passages: Passage[] } | undefined> {
      const [document] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.userId, userId)));
      if (!document) return undefined;

      const passages = await db
        .select({ ordinal: chunks.ordinal, page: chunks.page, content: chunks.content })
        .from(chunks)
        .where(
          and(
            eq(chunks.documentId, id),
            eq(chunks.userId, userId),
            gte(chunks.ordinal, Math.max(0, ordinal - radius)),
            lte(chunks.ordinal, ordinal + radius),
          ),
        )
        .orderBy(asc(chunks.ordinal));
      return { document, passages };
    },

    async deleteForUser(id: string, userId: string): Promise<boolean> {
      const deleted = await db
        .delete(documents)
        .where(and(eq(documents.id, id), eq(documents.userId, userId)))
        .returning({ id: documents.id });
      return deleted.length > 0;
    },

    async completeWithChunks(input: {
      documentId: string;
      userId: string;
      pageCount: number | null;
      chunks: NewChunk[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        for (let i = 0; i < input.chunks.length; i += CHUNK_INSERT_BATCH_SIZE) {
          const batch = input.chunks.slice(i, i + CHUNK_INSERT_BATCH_SIZE);
          await tx.insert(chunks).values(
            batch.map((chunk) => ({
              ...chunk,
              documentId: input.documentId,
              userId: input.userId,
            })),
          );
        }
        await tx
          .update(documents)
          .set({ status: 'ready', error: null, pageCount: input.pageCount })
          .where(eq(documents.id, input.documentId));
      });
    },

    async fail(documentId: string, message: string): Promise<void> {
      await db
        .update(documents)
        .set({ status: 'failed', error: message })
        .where(and(eq(documents.id, documentId), eq(documents.status, 'processing')));
    },

    async failInterrupted(message: string): Promise<number> {
      const interrupted = await db
        .update(documents)
        .set({ status: 'failed', error: message })
        .where(eq(documents.status, 'processing'))
        .returning({ id: documents.id });
      return interrupted.length;
    },
  };
}

export type DocumentRepository = ReturnType<typeof createDocumentRepository>;
