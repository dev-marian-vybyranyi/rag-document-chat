import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../db/errors.js';
import { embedInGroups } from '../documents/embedding-groups.js';
import { IngestionError } from '../documents/ingest.js';
import { createJobQueue } from '../documents/queue.js';
import type { DocumentRepository, NewChunk } from '../documents/repository.js';
import {
  chunkSourceFile,
  toEmbeddingText,
  type CodeChunk,
  type CodeChunkOptions,
} from './chunker.js';
import { ImportRejectedError, ImportUnavailableError } from './errors.js';
import { defaultImportLimits, type ImportLimits } from './filter.js';
import type { GithubImporter } from './github.js';
import { overviewChunks } from './overview.js';
import { importZipArchive, type ImportedRepository } from './zip.js';

export const DEFAULT_MAX_REPOSITORY_CHUNKS = 1_500;
const UNEXPECTED_MESSAGE = 'Something went wrong while importing the repository.';

export type RepositorySource = { kind: 'zip'; archive: Buffer } | { kind: 'github'; url: string };

export interface RepositoryJob {
  document: { id: string; userId: string; filename: string };
  source: RepositorySource;
}

export interface RepositoryIngestionService {
  enqueue(job: RepositoryJob): void;
  idle(): Promise<void>;
}

export interface RepositoryIngestionOptions {
  repository: DocumentRepository;
  embedder: Embedder;
  github: GithubImporter;
  logger: Logger;
  embeddingModel?: string;
  limits?: ImportLimits;
  chunkOptions?: CodeChunkOptions;
  maxChunks?: number;
  concurrency?: number;
}

interface ImportedSource {
  repository: ImportedRepository;
  url: string | null;
  commitSha: string | null;
}

export function createRepositoryIngestion(
  options: RepositoryIngestionOptions,
): RepositoryIngestionService {
  const {
    repository,
    embedder,
    github,
    logger,
    embeddingModel,
    chunkOptions,
    limits = defaultImportLimits,
    maxChunks = DEFAULT_MAX_REPOSITORY_CHUNKS,
  } = options;

  const queue = createJobQueue(options.concurrency ?? 1, (error) =>
    logger.error({ err: error }, 'repository import job crashed'),
  );

  async function load(job: RepositoryJob): Promise<ImportedSource> {
    if (job.source.kind === 'zip') {
      await repository.setProgress(job.document.id, { phase: 'reading', done: 0, total: 0 });
      const imported = await importZipArchive(job.source.archive, limits);
      return { repository: imported, url: null, commitSha: null };
    }
    await repository.setProgress(job.document.id, { phase: 'downloading', done: 0, total: 0 });
    const imported = await github.importFromUrl(job.source.url);
    return {
      repository: imported.repository,
      url: imported.source.url,
      commitSha: imported.source.commitSha,
    };
  }

  function chunkAll(job: RepositoryJob, imported: ImportedSource): CodeChunk[] {
    const { files } = imported.repository;
    const overview = overviewChunks(
      { name: job.document.filename, url: imported.url, commitSha: imported.commitSha, files },
      chunkOptions,
    );
    return [...overview, ...files.flatMap((file) => chunkSourceFile(file, chunkOptions))];
  }

  async function process(job: RepositoryJob): Promise<void> {
    const log = logger.child({ documentId: job.document.id, userId: job.document.userId });
    const startedAt = Date.now();

    try {
      const imported = await load(job);
      const chunks = chunkAll(job, imported);
      if (chunks.length > maxChunks) {
        throw new IngestionError(
          `The repository is too large to index: ${chunks.length} passages, the limit is ${maxChunks}`,
        );
      }
      log.info(
        {
          files: imported.repository.files.length,
          skipped: imported.repository.skipped.length,
          chunks: chunks.length,
        },
        'repository unpacked',
      );

      await repository.setProgress(job.document.id, {
        phase: 'embedding',
        done: 0,
        total: chunks.length,
      });
      const vectors = await embedInGroups(embedder, chunks.map(toEmbeddingText), (done, total) =>
        repository.setProgress(job.document.id, { phase: 'embedding', done, total }),
      );

      await repository.completeWithChunks({
        documentId: job.document.id,
        userId: job.document.userId,
        pageCount: null,
        embeddingModel,
        fileCount: imported.repository.files.length,
        ...(imported.commitSha && { commitSha: imported.commitSha }),
        chunks: chunks.map((chunk, i): NewChunk => ({
          ordinal: i,
          page: null,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: vectors[i]!,
          path: chunk.path,
          language: chunk.language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
        })),
      });
      log.info({ chunks: chunks.length, durationMs: Date.now() - startedAt }, 'repository indexed');
    } catch (error) {
      await recordFailure(job, error, log);
    }
  }

  async function recordFailure(job: RepositoryJob, error: unknown, log: Logger): Promise<void> {
    if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
      log.info('repository was deleted while it was being imported');
      return;
    }

    const known =
      error instanceof ImportRejectedError ||
      error instanceof ImportUnavailableError ||
      error instanceof IngestionError ||
      error instanceof EmbeddingError;
    if (known) log.warn({ err: error }, 'repository could not be imported');
    else log.error({ err: error }, 'unexpected failure while importing a repository');

    try {
      await repository.fail(job.document.id, known ? error.message : UNEXPECTED_MESSAGE);
    } catch (statusError) {
      log.error({ err: statusError }, 'could not record the failure of a repository import');
    }
  }

  return {
    enqueue(job) {
      queue.add(() => process(job));
    },
    idle: () => queue.idle(),
  };
}
