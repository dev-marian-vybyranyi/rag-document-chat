import { and, asc, count, desc, eq, getTableColumns, gte, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chunks, documents } from '../db/schema.js';
import type { CodeSource } from '../rag/code-source.js';

export type DocumentRecord = typeof documents.$inferSelect;

export type DocumentWithChunkCount = DocumentRecord & { chunkCount: number };

export type DocumentKind = DocumentRecord['kind'];

export interface CodeLocation {
  path: string | null;
  language: string | null;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}

export interface NewChunk extends Partial<CodeLocation> {
  ordinal: number;
  page: number | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export type ProgressPhase = 'downloading' | 'reading' | 'embedding';

export interface Progress {
  phase: ProgressPhase;
  done: number;
  total: number;
}

export interface Passage {
  ordinal: number;
  page: number | null;
  code?: CodeSource;
  content: string;
}

const CHUNK_INSERT_BATCH_SIZE = 100;

const chunkCountOf = sql<number>`(select count(*)::int from "chunks" c where c."document_id" = "documents"."id")`;

export function createDocumentRepository(db: Database) {
  return {
    async create(input: {
      userId: string;
      kind?: DocumentKind;
      repoUrl?: string;
      repoRef?: string | null;
      commitSha?: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }): Promise<DocumentRecord> {
      const [document] = await db.insert(documents).values(input).returning();
      return document!;
    },

    async countByUser(userId: string): Promise<number> {
      const [row] = await db
        .select({ total: count() })
        .from(documents)
        .where(eq(documents.userId, userId));
      return row?.total ?? 0;
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

      const rows = await db
        .select({
          ordinal: chunks.ordinal,
          page: chunks.page,
          content: chunks.content,
          path: chunks.path,
          language: chunks.language,
          startLine: chunks.startLine,
          endLine: chunks.endLine,
          symbol: chunks.symbol,
        })
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
      const passages: Passage[] = rows.map(
        ({ path, language, startLine, endLine, symbol, ...rest }) =>
          path === null ? rest : { ...rest, code: { path, language, startLine, endLine, symbol } },
      );
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
      embeddingModel?: string;
      suggestions?: string[];
      fileCount?: number;
      commitSha?: string;
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
          .set({
            status: 'ready',
            error: null,
            pageCount: input.pageCount,
            embeddingModel: input.embeddingModel ?? null,
            suggestions: input.suggestions ?? [],
            progressPhase: null,
            progressDone: null,
            progressTotal: null,
            ...(input.fileCount !== undefined && { fileCount: input.fileCount }),
            ...(input.commitSha !== undefined && { commitSha: input.commitSha }),
          })
          .where(eq(documents.id, input.documentId));
      });
    },

    async setProgress(documentId: string, progress: Progress): Promise<void> {
      await db
        .update(documents)
        .set({
          progressPhase: progress.phase,
          progressDone: progress.done,
          progressTotal: progress.total,
        })
        .where(and(eq(documents.id, documentId), eq(documents.status, 'processing')));
    },

    async countIndexedWithOtherModel(embeddingModel: string): Promise<number> {
      const [row] = await db
        .select({ total: count() })
        .from(documents)
        .where(
          and(
            eq(documents.status, 'ready'),
            sql`${documents.embeddingModel} is distinct from ${embeddingModel}`,
          ),
        );
      return row?.total ?? 0;
    },

    async fail(documentId: string, message: string): Promise<void> {
      await db
        .update(documents)
        .set({
          status: 'failed',
          error: message,
          progressPhase: null,
          progressDone: null,
          progressTotal: null,
        })
        .where(and(eq(documents.id, documentId), eq(documents.status, 'processing')));
    },

    async failInterrupted(message: string): Promise<number> {
      const interrupted = await db
        .update(documents)
        .set({
          status: 'failed',
          error: message,
          progressPhase: null,
          progressDone: null,
          progressTotal: null,
        })
        .where(eq(documents.status, 'processing'))
        .returning({ id: documents.id });
      return interrupted.length;
    },
  };
}

export type DocumentRepository = ReturnType<typeof createDocumentRepository>;
