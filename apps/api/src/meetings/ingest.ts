import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../db/errors.js';
import { embedInGroups } from '../documents/embedding-groups.js';
import { IngestionError } from '../documents/ingest.js';
import { createJobQueue } from '../documents/queue.js';
import type { DocumentRepository, NewChunk } from '../documents/repository.js';
import { chunkTranscript, type MeetingChunkOptions } from './chunker.js';
import type { ParsedTranscript } from './transcript.js';

export const DEFAULT_MAX_MEETING_CHUNKS = 1_500;
const UNEXPECTED_MESSAGE = 'Something went wrong while processing the transcript.';

export interface MeetingJob {
  document: { id: string; userId: string; filename: string };
  transcript: ParsedTranscript;
  heldOn?: string | null;
}

export interface MeetingIngestionService {
  enqueue(job: MeetingJob): void;
  idle(): Promise<void>;
}

export interface MeetingIngestionOptions {
  repository: DocumentRepository;
  embedder: Embedder;
  logger: Logger;
  embeddingModel?: string;
  chunkOptions?: Pick<MeetingChunkOptions, 'maxTokens' | 'maxGapMs'>;
  maxChunks?: number;
  concurrency?: number;
}

export function createMeetingIngestion(options: MeetingIngestionOptions): MeetingIngestionService {
  const {
    repository,
    embedder,
    logger,
    embeddingModel,
    chunkOptions,
    maxChunks = DEFAULT_MAX_MEETING_CHUNKS,
  } = options;

  const queue = createJobQueue(options.concurrency ?? 1, (error) =>
    logger.error({ err: error }, 'meeting job crashed'),
  );

  async function process(job: MeetingJob): Promise<void> {
    const log = logger.child({ documentId: job.document.id, userId: job.document.userId });
    const startedAt = Date.now();
    const { transcript } = job;

    try {
      const chunks = chunkTranscript(transcript.turns, {
        ...chunkOptions,
        title: job.document.filename,
        heldOn: job.heldOn ?? null,
        endMs: (transcript.turns[0]?.startMs ?? 0) + transcript.durationMs,
      });
      if (chunks.length > maxChunks) {
        throw new IngestionError(
          `The transcript is too long to index: ${chunks.length} passages, the limit is ${maxChunks}`,
        );
      }
      log.info(
        {
          turns: transcript.turns.length,
          speakers: transcript.participants.length,
          chunks: chunks.length,
        },
        'transcript chunked',
      );

      await repository.setProgress(job.document.id, {
        phase: 'embedding',
        done: 0,
        total: chunks.length,
      });
      const vectors = await embedInGroups(
        embedder,
        chunks.map((chunk) => chunk.content),
        (done, total) =>
          repository.setProgress(job.document.id, { phase: 'embedding', done, total }),
      );

      await repository.completeWithChunks({
        documentId: job.document.id,
        userId: job.document.userId,
        pageCount: null,
        embeddingModel,
        chunks: chunks.map((chunk, i): NewChunk => ({
          ordinal: i,
          page: null,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: vectors[i]!,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          speakers: chunk.speakers,
        })),
      });
      log.info({ chunks: chunks.length, durationMs: Date.now() - startedAt }, 'meeting indexed');
    } catch (error) {
      await recordFailure(job, error, log);
    }
  }

  async function recordFailure(job: MeetingJob, error: unknown, log: Logger): Promise<void> {
    if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
      log.info('meeting was deleted while it was being processed');
      return;
    }

    const known = error instanceof IngestionError || error instanceof EmbeddingError;
    if (known) log.warn({ err: error }, 'meeting could not be indexed');
    else log.error({ err: error }, 'unexpected failure while indexing a meeting');

    try {
      await repository.fail(job.document.id, known ? error.message : UNEXPECTED_MESSAGE);
    } catch (statusError) {
      log.error({ err: statusError }, 'could not record the failure of a meeting');
    }
  }

  return {
    enqueue(job) {
      queue.add(() => process(job));
    },
    idle: () => queue.idle(),
  };
}
