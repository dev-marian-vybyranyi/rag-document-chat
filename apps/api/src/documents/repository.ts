import { and, asc, count, desc, eq, getTableColumns, gte, lte, sql } from 'drizzle-orm';
import type { CareerProfile, CareerSection, Fit } from '../career/types.js';
import type { Database } from '../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/errors.js';
import { chunks, documents } from '../db/schema.js';
import type { MeetingLocation, MeetingNotes } from '../meetings/types.js';
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
  startMs?: number | null;
  endMs?: number | null;
  speakers?: string[] | null;
  section?: CareerSection | null;
  ordinal: number;
  page: number | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export type ProgressPhase = 'downloading' | 'reading' | 'analyzing' | 'transcribing' | 'embedding';

export interface Progress {
  phase: ProgressPhase;
  done: number;
  total: number;
}

export interface Passage {
  ordinal: number;
  page: number | null;
  code?: CodeSource;
  meeting?: MeetingLocation;
  content: string;
}

const CHUNK_INSERT_BATCH_SIZE = 100;
const MAX_NUMBERING_ATTEMPTS = 5;

export interface NewDocument {
  userId: string;
  kind?: DocumentKind;
  repoUrl?: string;
  repoRef?: string | null;
  commitSha?: string;
  meetingHeldOn?: string;
  participants?: string[];
  durationMs?: number;
  jobNumber?: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

const chunkCountOf = sql<number>`(select count(*)::int from "chunks" c where c."document_id" = "documents"."id")`;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function replaceChunksOfSection(
  tx: Transaction,
  section: CareerSection,
  input: { documentId: string; userId: string; chunks: Omit<NewChunk, 'ordinal'>[] },
): Promise<void> {
  await tx
    .delete(chunks)
    .where(and(eq(chunks.documentId, input.documentId), eq(chunks.section, section)));
  const [last] = await tx
    .select({ ordinal: sql<number>`coalesce(max(${chunks.ordinal}), -1)::int` })
    .from(chunks)
    .where(eq(chunks.documentId, input.documentId));
  const first = (last?.ordinal ?? -1) + 1;
  if (input.chunks.length === 0) return;
  await tx.insert(chunks).values(
    input.chunks.map((chunk, i) => ({
      ...chunk,
      ordinal: first + i,
      section,
      documentId: input.documentId,
      userId: input.userId,
    })),
  );
}

export function createDocumentRepository(db: Database) {
  return {
    async create(input: NewDocument): Promise<DocumentRecord> {
      const [document] = await db.insert(documents).values(input).returning();
      return document!;
    },

    async createJobPosting(
      input: Omit<NewDocument, 'kind' | 'jobNumber'>,
    ): Promise<DocumentRecord> {
      for (let attempt = 1; ; attempt++) {
        const [last] = await db
          .select({ number: sql<number>`coalesce(max(${documents.jobNumber}), 0)::int` })
          .from(documents)
          .where(and(eq(documents.userId, input.userId), eq(documents.kind, 'job_posting')));
        try {
          const [document] = await db
            .insert(documents)
            .values({ ...input, kind: 'job_posting', jobNumber: (last?.number ?? 0) + 1 })
            .returning();
          return document!;
        } catch (error) {
          if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION || attempt >= MAX_NUMBERING_ATTEMPTS) {
            throw error;
          }
        }
      }
    },

    async countByKind(userId: string, kind: DocumentKind): Promise<number> {
      const [row] = await db
        .select({ total: count() })
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.kind, kind)));
      return row?.total ?? 0;
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
          startMs: chunks.startMs,
          endMs: chunks.endMs,
          speakers: chunks.speakers,
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
        ({ path, language, startLine, endLine, symbol, startMs, endMs, speakers, ...rest }) => ({
          ...rest,
          ...(path !== null && { code: { path, language, startLine, endLine, symbol } }),
          ...(speakers !== null && { meeting: { startMs, endMs, speakers } }),
        }),
      );
      return { document, passages };
    },

    async transcriptPassages(id: string, userId: string): Promise<string[]> {
      const rows = await db
        .select({ content: chunks.content })
        .from(chunks)
        .where(
          and(
            eq(chunks.documentId, id),
            eq(chunks.userId, userId),
            sql`${chunks.startMs} is not null`,
          ),
        )
        .orderBy(asc(chunks.ordinal));
      return rows.map((row) => row.content);
    },

    async careerPassages(id: string, userId: string): Promise<string[]> {
      const rows = await db
        .select({ content: chunks.content })
        .from(chunks)
        .where(
          and(
            eq(chunks.documentId, id),
            eq(chunks.userId, userId),
            sql`(${chunks.section} is null or ${chunks.section} not in ('profile', 'fit', 'overview'))`,
          ),
        )
        .orderBy(asc(chunks.ordinal));
      return rows.map((row) => row.content);
    },

    async replaceProfile(input: {
      documentId: string;
      userId: string;
      profile: CareerProfile;
      chunks: Omit<NewChunk, 'ordinal'>[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await replaceChunksOfSection(tx, 'profile', input);
        await tx
          .update(documents)
          .set({ profile: input.profile })
          .where(eq(documents.id, input.documentId));
      });
    },

    async replaceFit(input: {
      documentId: string;
      userId: string;
      fit: Fit | null;
      chunks: Omit<NewChunk, 'ordinal'>[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await replaceChunksOfSection(tx, 'fit', input);
        await tx
          .update(documents)
          .set({ fit: input.fit })
          .where(eq(documents.id, input.documentId));
      });
    },

    async replaceOverview(input: {
      documentId: string;
      userId: string;
      chunks: Omit<NewChunk, 'ordinal'>[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await replaceChunksOfSection(tx, 'overview', input);
      });
    },

    async replaceNotes(input: {
      documentId: string;
      userId: string;
      notes: MeetingNotes;
      chunks: Omit<NewChunk, 'ordinal'>[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .delete(chunks)
          .where(and(eq(chunks.documentId, input.documentId), sql`${chunks.startMs} is null`));
        const [last] = await tx
          .select({ ordinal: sql<number>`coalesce(max(${chunks.ordinal}), -1)::int` })
          .from(chunks)
          .where(eq(chunks.documentId, input.documentId));
        const first = (last?.ordinal ?? -1) + 1;
        if (input.chunks.length > 0) {
          await tx.insert(chunks).values(
            input.chunks.map((chunk, i) => ({
              ...chunk,
              ordinal: first + i,
              documentId: input.documentId,
              userId: input.userId,
            })),
          );
        }
        await tx
          .update(documents)
          .set({ notes: input.notes })
          .where(eq(documents.id, input.documentId));
      });
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
      participants?: string[];
      durationMs?: number;
      notes?: MeetingNotes | null;
      profile?: CareerProfile | null;
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
            ...(input.participants !== undefined && { participants: input.participants }),
            ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
            ...(input.notes !== undefined && { notes: input.notes }),
            ...(input.profile !== undefined && { profile: input.profile }),
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
