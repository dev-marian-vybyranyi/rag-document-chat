import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import type { Database } from '../db/client.js';
import { chunks, documents, users } from '../db/schema.js';
import { createDocumentRepository } from '../documents/repository.js';
import type { GithubImporter } from '../repositories/github.js';
import { createRepositoryIngestion } from '../repositories/ingest.js';
import { OVERVIEW_PATH } from '../repositories/overview.js';
import { containsWord, type GoldenSet } from './golden.js';
import { QuotaExhaustedError } from './quota-exhausted.js';
import {
  isReferenceFile,
  REFERENCE_ADDRESS,
  REFERENCE_REPOSITORY,
  selectReferenceFiles,
} from './reference-repository.js';

export const EVAL_CODE_USER_EMAIL = 'eval-code@rag-chat.invalid';
const UNUSABLE_PASSWORD_HASH = 'not-a-password-hash';
const DOCUMENT_NAME = `${REFERENCE_REPOSITORY.owner}/${REFERENCE_REPOSITORY.name}`;
const QUOTA_EXHAUSTED_MESSAGE = new EmbeddingError('quota_exhausted').message;

export class CodeCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeCorpusError';
  }
}

export interface CodeCorpusResult {
  userId: string;
  documentId: string;
  reused: boolean;
}

export function restrictToReferenceFiles(github: GithubImporter): GithubImporter {
  return {
    async importFromUrl(url) {
      const imported = await github.importFromUrl(url);
      return {
        ...imported,
        repository: {
          ...imported.repository,
          files: selectReferenceFiles(imported.repository.files),
        },
      };
    },
  };
}

interface CorpusOptions {
  db: Database;
  embedder: Embedder;
  embeddingModel?: string;
  logger: Logger;
  github: GithubImporter;
  reindex?: boolean;
  attempts?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number, error: string) => void;
}

async function evalUser(db: Database) {
  const [existing] = await db.select().from(users).where(eq(users.email, EVAL_CODE_USER_EMAIL));
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ email: EVAL_CODE_USER_EMAIL, passwordHash: UNUSABLE_PASSWORD_HASH })
    .returning();
  return created!;
}

async function isUpToDate(
  db: Database,
  userId: string,
  embeddingModel: string | undefined,
): Promise<string | undefined> {
  const found = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.filename, DOCUMENT_NAME)));
  const current = found.find(
    (doc) =>
      doc.status === 'ready' &&
      doc.commitSha === REFERENCE_REPOSITORY.commit &&
      (embeddingModel === undefined || doc.embeddingModel === embeddingModel),
  );
  if (!current) return undefined;

  const paths = await db
    .selectDistinct({ path: chunks.path })
    .from(chunks)
    .where(eq(chunks.documentId, current.id));
  const stale = paths.some(
    ({ path }) => path !== null && path !== OVERVIEW_PATH && !isReferenceFile(path),
  );
  return stale ? undefined : current.id;
}

export async function ensureCodeEvalCorpus(options: CorpusOptions): Promise<CodeCorpusResult> {
  const {
    db,
    embedder,
    embeddingModel,
    logger,
    github,
    reindex = false,
    attempts = 3,
    retryDelayMs = 65_000,
    onRetry,
  } = options;
  const repository = createDocumentRepository(db);
  const user = await evalUser(db);

  const upToDate = reindex ? undefined : await isUpToDate(db, user.id, embeddingModel);
  if (upToDate) return { userId: user.id, documentId: upToDate, reused: true };

  const stale = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, user.id), eq(documents.filename, DOCUMENT_NAME)));
  for (const doc of stale) await repository.deleteForUser(doc.id, user.id);

  const ingestion = createRepositoryIngestion({
    repository,
    embedder,
    github: restrictToReferenceFiles(github),
    logger,
    embeddingModel,
  });

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const document = await repository.create({
      userId: user.id,
      kind: 'repository',
      filename: DOCUMENT_NAME,
      mimeType: 'application/zip',
      sizeBytes: 0,
      repoUrl: `https://github.com/${DOCUMENT_NAME}`,
      repoRef: REFERENCE_REPOSITORY.commit,
    });
    ingestion.enqueue({ document, source: { kind: 'github', url: REFERENCE_ADDRESS } });
    await ingestion.idle();

    const [after] = await db.select().from(documents).where(eq(documents.id, document.id));
    if (after?.status === 'ready') {
      if (after.commitSha !== REFERENCE_REPOSITORY.commit) {
        await repository.deleteForUser(document.id, user.id);
        throw new CodeCorpusError(
          `GitHub returned commit ${after.commitSha} instead of ${REFERENCE_REPOSITORY.commit}`,
        );
      }
      return { userId: user.id, documentId: document.id, reused: false };
    }

    lastError = after?.error ?? lastError;
    await repository.deleteForUser(document.id, user.id);
    if (lastError === QUOTA_EXHAUSTED_MESSAGE) throw new QuotaExhaustedError();
    if (attempt < attempts) {
      onRetry?.(attempt, lastError);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new CodeCorpusError(lastError);
}

export async function passagesByPath(db: Database, userId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ path: chunks.path, content: chunks.content })
    .from(chunks)
    .where(eq(chunks.userId, userId))
    .orderBy(chunks.path, chunks.ordinal);
  const byPath = new Map<string, string[]>();
  for (const row of rows) {
    if (row.path === null) continue;
    byPath.set(row.path, [...(byPath.get(row.path) ?? []), row.content]);
  }
  return byPath;
}

export interface PresentTerm {
  id: string;
  term: string;
  path: string;
}

export function findPresentAbsentTerms(
  golden: GoldenSet,
  passages: Map<string, string[]>,
): PresentTerm[] {
  const found: PresentTerm[] = [];
  for (const question of golden.questions) {
    if (question.type !== 'unanswerable') continue;
    for (const term of question.absentTerms) {
      for (const [path, contents] of passages) {
        if (path !== OVERVIEW_PATH && contents.some((content) => containsWord(content, term))) {
          found.push({ id: question.id, term, path });
        }
      }
    }
  }
  return found;
}

export async function removeCodeEvalUser(db: Database): Promise<boolean> {
  const removed = await db
    .delete(users)
    .where(eq(users.email, EVAL_CODE_USER_EMAIL))
    .returning({ id: users.id });
  return removed.length > 0;
}
