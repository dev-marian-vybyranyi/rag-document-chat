import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import type { Database } from '../db/client.js';
import { documents, users } from '../db/schema.js';
import { createDocumentRepository } from '../documents/repository.js';
import { createMeetingIngestion } from '../meetings/ingest.js';
import { createNoopNotesExtractor, type NotesExtractor } from '../meetings/notes-extractor.js';
import { parseTranscript } from '../meetings/parser.js';
import { createMeetingNotesService } from '../meetings/regenerate.js';
import type { MeetingNotes } from '../meetings/types.js';
import type { GoldenMeetings } from './golden-meetings.js';
import { QuotaExhaustedError } from './quota-exhausted.js';

export const EVAL_MEETINGS_USER_EMAIL = 'eval-meetings@rag-chat.invalid';
const UNUSABLE_PASSWORD_HASH = 'not-a-password-hash';
const QUOTA_EXHAUSTED_MESSAGE = new EmbeddingError('quota_exhausted').message;

export class MeetingCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingCorpusError';
  }
}

export interface MeetingCorpusResult {
  userId: string;
  documents: Map<string, string>;
  indexed: string[];
  reused: string[];
  withoutNotes: string[];
}

interface CorpusOptions {
  db: Database;
  embedder: Embedder;
  embeddingModel?: string;
  logger: Logger;
  golden: GoldenMeetings;
  samplesDir: string;
  notes?: NotesExtractor;
  reindex?: boolean;
  attempts?: number;
  retryDelayMs?: number;
  onRetry?: (what: string, attempt: number, error: string) => void;
}

async function evalUser(db: Database) {
  const [existing] = await db.select().from(users).where(eq(users.email, EVAL_MEETINGS_USER_EMAIL));
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ email: EVAL_MEETINGS_USER_EMAIL, passwordHash: UNUSABLE_PASSWORD_HASH })
    .returning();
  return created!;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function ensureMeetingEvalCorpus(
  options: CorpusOptions,
): Promise<MeetingCorpusResult> {
  const {
    db,
    embedder,
    embeddingModel,
    logger,
    golden,
    samplesDir,
    notes = createNoopNotesExtractor(),
    reindex = false,
    attempts = 3,
    retryDelayMs = 65_000,
    onRetry,
  } = options;
  const repository = createDocumentRepository(db);
  const user = await evalUser(db);
  const ingestion = createMeetingIngestion({ repository, embedder, logger, embeddingModel, notes });
  const writer = createMeetingNotesService({
    repository,
    embedder,
    extractor: notes,
    embeddingModel,
  });
  const wantsNotes = options.notes !== undefined;

  const result: MeetingCorpusResult = {
    userId: user.id,
    documents: new Map(),
    indexed: [],
    reused: [],
    withoutNotes: [],
  };

  for (const meeting of golden.meetings) {
    const content = readFileSync(join(samplesDir, meeting.file));
    const transcript = parseTranscript(content.toString('utf8'));
    const existing = await db
      .select()
      .from(documents)
      .where(and(eq(documents.userId, user.id), eq(documents.filename, meeting.title)));

    const current = existing.find(
      (doc) =>
        doc.status === 'ready' &&
        !reindex &&
        doc.sizeBytes === content.length &&
        doc.meetingHeldOn === meeting.heldOn &&
        (embeddingModel === undefined || doc.embeddingModel === embeddingModel),
    );

    let documentId = current?.id;
    if (current) {
      result.reused.push(meeting.file);
    } else {
      for (const doc of existing) await repository.deleteForUser(doc.id, user.id);
      let lastError = 'unknown error';
      for (let attempt = 1; attempt <= attempts && !documentId; attempt++) {
        const document = await repository.create({
          userId: user.id,
          kind: 'transcript',
          filename: meeting.title,
          mimeType: meeting.file.endsWith('.vtt') ? 'text/vtt' : 'text/plain',
          sizeBytes: content.length,
          participants: transcript.participants,
          durationMs: transcript.durationMs,
          meetingHeldOn: meeting.heldOn,
        });
        ingestion.enqueue({ document, transcript, heldOn: meeting.heldOn });
        await ingestion.idle();

        const [after] = await db.select().from(documents).where(eq(documents.id, document.id));
        if (after?.status === 'ready') {
          documentId = document.id;
          break;
        }
        lastError = after?.error ?? lastError;
        await repository.deleteForUser(document.id, user.id);
        if (lastError === QUOTA_EXHAUSTED_MESSAGE) throw new QuotaExhaustedError();
        if (attempt < attempts) {
          onRetry?.(meeting.file, attempt, lastError);
          await sleep(retryDelayMs);
        }
      }
      if (!documentId) throw new MeetingCorpusError(`${meeting.file}: ${lastError}`);
      result.indexed.push(meeting.file);
    }

    result.documents.set(meeting.file, documentId!);

    if (wantsNotes) {
      const hasNotes = async () => {
        const [row] = await db.select().from(documents).where(eq(documents.id, documentId!));
        return row?.notes !== null && row?.notes !== undefined;
      };
      let present = await hasNotes();
      for (let attempt = 1; !present && attempt <= attempts; attempt++) {
        present = (await writer.regenerate(documentId!, user.id)).status === 'done';
        if (!present && attempt < attempts) {
          onRetry?.(`${meeting.file} notes`, attempt, 'the notes could not be written');
          await sleep(retryDelayMs);
        }
      }
      if (!present) result.withoutNotes.push(meeting.file);
    }
  }
  return result;
}

export async function storedNotes(
  db: Database,
  userId: string,
  golden: GoldenMeetings,
): Promise<Map<string, MeetingNotes | null>> {
  const rows = await db.select().from(documents).where(eq(documents.userId, userId));
  return new Map(
    golden.meetings.map((meeting) => [
      meeting.file,
      rows.find((row) => row.filename === meeting.title)?.notes ?? null,
    ]),
  );
}

export async function removeMeetingEvalUser(db: Database): Promise<boolean> {
  const removed = await db
    .delete(users)
    .where(eq(users.email, EVAL_MEETINGS_USER_EMAIL))
    .returning({ id: users.id });
  return removed.length > 0;
}
