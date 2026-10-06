import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chunks, documents } from '../db/schema.js';

export type DocumentRecord = typeof documents.$inferSelect;

export interface NewChunk {
  ordinal: number;
  page: number | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

const CHUNK_INSERT_BATCH_SIZE = 100;

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
