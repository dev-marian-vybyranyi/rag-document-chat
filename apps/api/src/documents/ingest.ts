import type { Logger } from 'pino';
import type { Embedder } from '../ai/embeddings.js';
import { EmbeddingError } from '../ai/embeddings.js';
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../db/errors.js';
import { chunkSegments, type ChunkOptions } from './chunker.js';
import { ExtractionError, extractText } from './extract.js';
import type { FileType } from './file-types.js';
import { createJobQueue } from './queue.js';
import type { DocumentRepository } from './repository.js';

export const DEFAULT_MAX_CHUNKS = 2000;
export const EMBEDDING_GROUP_SIZE = 100;
export const INTERRUPTED_MESSAGE = 'Processing was interrupted. Please upload the file again.';
const UNEXPECTED_MESSAGE = 'Something went wrong while processing the document.';

export interface IngestionJob {
  document: { id: string; userId: string };
  type: FileType;
  content: Buffer;
}

export interface IngestionService {
  enqueue(job: IngestionJob): void;
  idle(): Promise<void>;
}

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionError';
  }
}

export interface IngestionOptions {
  repository: DocumentRepository;
  embedder: Embedder;
  logger: Logger;
  chunkOptions?: ChunkOptions;
  maxChunks?: number;
  concurrency?: number;
}

export function createIngestionService(options: IngestionOptions): IngestionService {
  const { repository, embedder, logger, chunkOptions, maxChunks = DEFAULT_MAX_CHUNKS } = options;

  const queue = createJobQueue(options.concurrency ?? 1, (error) =>
    logger.error({ err: error }, 'ingestion job crashed'),
  );

  async function embedInGroups(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_GROUP_SIZE) {
      vectors.push(...(await embedder.embedDocuments(texts.slice(i, i + EMBEDDING_GROUP_SIZE))));
    }
    return vectors;
  }

  async function process(job: IngestionJob): Promise<void> {
    const log = logger.child({ documentId: job.document.id, userId: job.document.userId });
    const startedAt = Date.now();

    try {
      const extracted = await extractText(job.type, job.content);
      const chunks = chunkSegments(extracted.segments, chunkOptions);
      if (chunks.length > maxChunks) {
        throw new IngestionError(`The document is too long to index (limit ${maxChunks} passages)`);
      }
      log.info({ pages: extracted.pageCount, chunks: chunks.length }, 'document text extracted');

      const vectors = await embedInGroups(chunks.map((chunk) => chunk.content));

      await repository.completeWithChunks({
        documentId: job.document.id,
        userId: job.document.userId,
        pageCount: extracted.pageCount,
        chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i]! })),
      });
      log.info({ chunks: chunks.length, durationMs: Date.now() - startedAt }, 'document indexed');
    } catch (error) {
      await recordFailure(job, error, log);
    }
  }

  async function recordFailure(job: IngestionJob, error: unknown, log: Logger): Promise<void> {
    if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
      log.info('document was deleted while it was being processed');
      return;
    }

    const known =
      error instanceof ExtractionError ||
      error instanceof IngestionError ||
      error instanceof EmbeddingError;
    if (known) log.warn({ err: error }, 'document could not be indexed');
    else log.error({ err: error }, 'unexpected failure while indexing document');

    try {
      await repository.fail(job.document.id, known ? error.message : UNEXPECTED_MESSAGE);
    } catch (statusError) {
      log.error({ err: statusError }, 'could not record the failure of a document');
    }
  }

  return {
    enqueue(job) {
      queue.add(() => process(job));
    },
    idle: () => queue.idle(),
  };
}
