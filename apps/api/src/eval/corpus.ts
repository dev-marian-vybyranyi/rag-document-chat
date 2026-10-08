import { and, eq } from 'drizzle-orm';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Embedder } from '../ai/embeddings.js';
import type { Database } from '../db/client.js';
import { chunks, documents, users } from '../db/schema.js';
import { detectFileType } from '../documents/file-types.js';
import { createIngestionService } from '../documents/ingest.js';
import { QuotaExhaustedError } from './quota-exhausted.js';
import { createDocumentRepository } from '../documents/repository.js';

export const EVAL_USER_EMAIL = 'eval@rag-chat.invalid';
const UNUSABLE_PASSWORD_HASH = 'not-a-password-hash';
export const DEFAULT_ATTEMPTS = 3;
const DAILY_QUOTA_MESSAGE = /daily quota/i;
export const DEFAULT_RETRY_DELAY_MS = 65_000;

export interface CorpusResult {
  userId: string;
  indexed: string[];
  reused: string[];
  failed: Array<{ filename: string; error: string }>;
}

export function listSampleFiles(samplesDir: string): string[] {
  return readdirSync(samplesDir)
    .filter((name) => statSync(join(samplesDir, name)).isFile() && detectFileType(name))
    .filter((name) => name !== 'SOURCES.md')
    .sort();
}

export async function ensureEvalCorpus(options: {
  db: Database;
  embedder: Embedder;
  logger: Logger;
  samplesDir: string;
  reindex?: boolean;
  attempts?: number;
  retryDelayMs?: number;
  onRetry?: (filename: string, attempt: number, error: string) => void;
}): Promise<CorpusResult> {
  const {
    db,
    embedder,
    logger,
    samplesDir,
    reindex = false,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    onRetry,
  } = options;
  const repository = createDocumentRepository(db);
  const ingestion = createIngestionService({ repository, embedder, logger });

  const [existing] = await db.select().from(users).where(eq(users.email, EVAL_USER_EMAIL));
  const user =
    existing ??
    (
      await db
        .insert(users)
        .values({ email: EVAL_USER_EMAIL, passwordHash: UNUSABLE_PASSWORD_HASH })
        .returning()
    )[0]!;

  const result: CorpusResult = { userId: user.id, indexed: [], reused: [], failed: [] };

  for (const filename of listSampleFiles(samplesDir)) {
    const content = readFileSync(join(samplesDir, filename));
    const type = detectFileType(filename)!;
    const current = await db
      .select()
      .from(documents)
      .where(and(eq(documents.userId, user.id), eq(documents.filename, filename)));

    const upToDate = current.some((d) => d.status === 'ready' && d.sizeBytes === content.length);
    if (upToDate && !reindex) {
      result.reused.push(filename);
      continue;
    }
    for (const stale of current) await repository.deleteForUser(stale.id, user.id);

    let lastError = 'unknown error';
    let indexed = false;
    for (let attempt = 1; attempt <= attempts && !indexed; attempt++) {
      const document = await repository.create({
        userId: user.id,
        filename,
        mimeType: type.mimeType,
        sizeBytes: content.length,
      });
      ingestion.enqueue({ document, type, content });
      await ingestion.idle();

      const [after] = await db.select().from(documents).where(eq(documents.id, document.id));
      if (after?.status === 'ready') {
        indexed = true;
        break;
      }
      lastError = after?.error ?? lastError;
      await repository.deleteForUser(document.id, user.id);
      if (DAILY_QUOTA_MESSAGE.test(lastError)) throw new QuotaExhaustedError();
      if (attempt < attempts) {
        onRetry?.(filename, attempt, lastError);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    if (indexed) result.indexed.push(filename);
    else result.failed.push({ filename, error: lastError });
  }
  return result;
}

export async function passagesByFile(db: Database, userId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ filename: documents.filename, content: chunks.content })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .where(eq(chunks.userId, userId))
    .orderBy(documents.filename, chunks.ordinal);
  const byFile = new Map<string, string[]>();
  for (const row of rows)
    byFile.set(row.filename, [...(byFile.get(row.filename) ?? []), row.content]);
  return byFile;
}

export async function removeEvalUser(db: Database): Promise<boolean> {
  const removed = await db
    .delete(users)
    .where(eq(users.email, EVAL_USER_EMAIL))
    .returning({ id: users.id });
  return removed.length > 0;
}
