import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../db/errors.js';
import { estimateTokens } from '../documents/chunker.js';
import { embedInGroups } from '../documents/embedding-groups.js';
import { IngestionError } from '../documents/ingest.js';
import { createJobQueue } from '../documents/queue.js';
import type { DocumentRepository, NewChunk } from '../documents/repository.js';
import { chunkTranscript, type MeetingChunkOptions } from './chunker.js';
import { createNoopNotesExtractor, type NotesExtractor } from './notes-extractor.js';
import { notesPassages } from './notes-text.js';
import {
  defaultTranscriptLimits,
  transcriptLimitProblem,
  type TranscriptLimits,
} from './limits.js';
import type { ParsedTranscript } from './transcript.js';
import {
  createUnconfiguredTranscriber,
  TranscriptionError,
  type AudioInput,
  type Transcriber,
} from './transcriber.js';

export const DEFAULT_MAX_MEETING_CHUNKS = 1_500;
export const MAX_PENDING_RECORDINGS = 3;
const UNEXPECTED_MESSAGE = 'Something went wrong while processing the transcript.';

interface MeetingJobBase {
  document: { id: string; userId: string; filename: string };
  heldOn?: string | null;
}

export interface TextMeetingJob extends MeetingJobBase {
  transcript: ParsedTranscript;
  audio?: undefined;
}

export interface RecordingMeetingJob extends MeetingJobBase {
  audio: AudioInput | undefined;
  transcript?: undefined;
}

export type MeetingJob = TextMeetingJob | RecordingMeetingJob;

export interface MeetingIngestionService {
  enqueue(job: MeetingJob): void;
  pendingRecordings(): number;
  pending(): number;
  idle(): Promise<void>;
}

export interface MeetingIngestionOptions {
  repository: DocumentRepository;
  embedder: Embedder;
  logger: Logger;
  embeddingModel?: string;
  notes?: NotesExtractor;
  transcriber?: Transcriber;
  limits?: TranscriptLimits;
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
    notes: notesExtractor = createNoopNotesExtractor(),
    transcriber = createUnconfiguredTranscriber('the transcription service'),
    limits = defaultTranscriptLimits,
  } = options;
  let pendingRecordings = 0;

  const queue = createJobQueue(options.concurrency ?? 1, (error) =>
    logger.error({ err: error }, 'meeting job crashed'),
  );

  async function transcriptOf(job: MeetingJob, log: Logger): Promise<ParsedTranscript> {
    const audio = job.audio;
    if (audio === undefined) {
      if (job.transcript === undefined) throw new Error('A meeting job has neither text nor audio');
      return job.transcript;
    }
    try {
      await repository.setProgress(job.document.id, { phase: 'transcribing', done: 0, total: 0 });
      const startedAt = Date.now();
      const transcript = await transcriber.transcribe(audio);
      log.info(
        {
          turns: transcript.turns.length,
          speakers: transcript.participants.length,
          durationMs: Date.now() - startedAt,
          outOfOrderTurns: transcript.outOfOrderTurns,
        },
        'recording transcribed',
      );
      const problem = transcriptLimitProblem(transcript, limits);
      if (problem) throw new IngestionError(problem);
      return transcript;
    } finally {
      job.audio = undefined;
      pendingRecordings--;
    }
  }

  async function process(job: MeetingJob): Promise<void> {
    const log = logger.child({ documentId: job.document.id, userId: job.document.userId });
    const startedAt = Date.now();
    const fromRecording = job.audio !== undefined;

    try {
      const transcript = await transcriptOf(job, log);
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

      await repository.setProgress(job.document.id, { phase: 'analyzing', done: 0, total: 0 });
      const notes = await notesExtractor.extract({
        title: job.document.filename,
        heldOn: job.heldOn ?? null,
        turns: transcript.turns,
      });

      const noteTexts = notes
        ? notesPassages(notes, {
            title: job.document.filename,
            heldOn: job.heldOn ?? null,
            participants: transcript.participants,
          })
        : [];
      const texts = [...chunks.map((chunk) => chunk.content), ...noteTexts];

      await repository.setProgress(job.document.id, {
        phase: 'embedding',
        done: 0,
        total: texts.length,
      });
      const vectors = await embedInGroups(embedder, texts, (done, total) =>
        repository.setProgress(job.document.id, { phase: 'embedding', done, total }),
      );

      await repository.completeWithChunks({
        documentId: job.document.id,
        userId: job.document.userId,
        pageCount: null,
        embeddingModel,
        notes,
        ...(fromRecording
          ? { participants: transcript.participants, durationMs: transcript.durationMs }
          : {}),
        chunks: chunks
          .map((chunk, i): NewChunk => ({
            ordinal: i,
            page: null,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            embedding: vectors[i]!,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            speakers: chunk.speakers,
          }))
          .concat(
            noteTexts.map((content, i): NewChunk => ({
              ordinal: chunks.length + i,
              page: null,
              content,
              tokenCount: estimateTokens(content),
              embedding: vectors[chunks.length + i]!,
              speakers: transcript.participants,
            })),
          ),
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

    const known =
      error instanceof IngestionError ||
      error instanceof EmbeddingError ||
      error instanceof TranscriptionError;
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
      if (job.audio !== undefined) pendingRecordings++;
      queue.add(() => process(job));
    },
    pendingRecordings: () => pendingRecordings,
    pending: () => queue.pending(),
    idle: () => queue.idle(),
  };
}
