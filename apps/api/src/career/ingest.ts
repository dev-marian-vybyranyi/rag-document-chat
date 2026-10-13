import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../db/errors.js';
import { embedInGroups } from '../documents/embedding-groups.js';
import { ExtractionError, extractText, type ExtractedText } from '../documents/extract.js';
import type { FileType } from '../documents/file-types.js';
import { IngestionError } from '../documents/ingest.js';
import { createJobQueue } from '../documents/queue.js';
import type { DocumentRecord, DocumentRepository, NewChunk } from '../documents/repository.js';
import { chunkSections, type CareerChunkOptions } from './chunker.js';
import { cleanLabel } from './labels.js';
import { defaultCareerLimits, type CareerLimits } from './limits.js';
import { redactResume, type RedactionCounts } from './redact.js';
import { splitIntoSections } from './sections.js';

export const DEFAULT_MAX_CAREER_CHUNKS = 200;
const UNEXPECTED_MESSAGE = 'Something went wrong while processing the file.';

export interface CareerJob {
  document: Pick<DocumentRecord, 'id' | 'userId' | 'filename' | 'kind' | 'jobNumber'>;
  type: FileType;
  content: Buffer;
}

export interface CareerIngestionService {
  enqueue(job: CareerJob): void;
  idle(): Promise<void>;
}

export interface CareerIngestionOptions {
  repository: DocumentRepository;
  embedder: Embedder;
  logger: Logger;
  embeddingModel?: string;
  limits?: CareerLimits;
  chunkOptions?: Pick<CareerChunkOptions, 'maxChars'>;
  maxChunks?: number;
  concurrency?: number;
}

type CareerKind = 'resume' | 'job_posting';

function careerKindOf(job: CareerJob): CareerKind {
  if (job.document.kind !== 'resume' && job.document.kind !== 'job_posting') {
    throw new Error(`A ${job.document.kind} cannot be indexed as a resume or a job posting`);
  }
  return job.document.kind;
}

function labelOf(job: CareerJob, kind: CareerKind): string {
  if (kind === 'resume') return 'Resume';
  const number = job.document.jobNumber;
  const name = cleanLabel(job.document.filename);
  return number === null ? name : `Job #${number} · ${name}`;
}

function characterCount(extracted: ExtractedText): number {
  return extracted.segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

export function createCareerIngestion(options: CareerIngestionOptions): CareerIngestionService {
  const {
    repository,
    embedder,
    logger,
    embeddingModel,
    chunkOptions,
    limits = defaultCareerLimits,
    maxChunks = DEFAULT_MAX_CAREER_CHUNKS,
  } = options;

  const queue = createJobQueue(options.concurrency ?? 1, (error) =>
    logger.error({ err: error }, 'career job crashed'),
  );

  async function process(job: CareerJob): Promise<void> {
    const log = logger.child({ documentId: job.document.id, userId: job.document.userId });
    const startedAt = Date.now();

    try {
      const kind = careerKindOf(job);
      const what = kind === 'resume' ? 'resume' : 'job posting';
      await repository.setProgress(job.document.id, { phase: 'reading', done: 0, total: 0 });

      const extracted = await extractText(job.type, job.content, {
        maxPages: kind === 'resume' ? limits.maxResumePages : limits.maxJobPages,
        preserveLines: true,
      });
      const maxCharacters =
        kind === 'resume' ? limits.maxResumeCharacters : limits.maxJobCharacters;
      if (characterCount(extracted) > maxCharacters) {
        throw new IngestionError(
          `The ${what} is too long (limit ${maxCharacters.toLocaleString('en-US')} characters)`,
        );
      }

      let removed: RedactionCounts | undefined;
      const segments =
        kind === 'resume'
          ? extracted.segments.map((segment) => {
              const redaction = redactResume(segment.text);
              removed = addCounts(removed, redaction.removed);
              return { ...segment, text: redaction.text };
            })
          : extracted.segments;

      const chunks = chunkSections(splitIntoSections(kind, segments), {
        label: labelOf(job, kind),
        ...chunkOptions,
      });
      if (chunks.length === 0) {
        throw new IngestionError(`The ${what} contains no readable text`);
      }
      if (chunks.length > maxChunks) {
        throw new IngestionError(`The ${what} is too long to index (limit ${maxChunks} passages)`);
      }
      log.info(
        { kind, pages: extracted.pageCount, chunks: chunks.length, removed },
        'career text prepared',
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
        pageCount: extracted.pageCount,
        embeddingModel,
        chunks: chunks.map((chunk, i): NewChunk => ({
          ordinal: chunk.ordinal,
          page: chunk.page,
          section: chunk.section,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: vectors[i]!,
        })),
      });
      log.info(
        { kind, chunks: chunks.length, durationMs: Date.now() - startedAt },
        'career source indexed',
      );
    } catch (error) {
      await recordFailure(job, error, log);
    }
  }

  async function recordFailure(job: CareerJob, error: unknown, log: Logger): Promise<void> {
    if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
      log.info('career source was deleted while it was being processed');
      return;
    }

    const known =
      error instanceof ExtractionError ||
      error instanceof IngestionError ||
      error instanceof EmbeddingError;
    if (known) log.warn({ err: error }, 'career source could not be indexed');
    else log.error({ err: error }, 'unexpected failure while indexing a career source');

    try {
      await repository.fail(job.document.id, known ? error.message : UNEXPECTED_MESSAGE);
    } catch (statusError) {
      log.error({ err: statusError }, 'could not record the failure of a career source');
    }
  }

  return {
    enqueue(job) {
      queue.add(() => process(job));
    },
    idle: () => queue.idle(),
  };
}

function addCounts(total: RedactionCounts | undefined, next: RedactionCounts): RedactionCounts {
  if (total === undefined) return { ...next };
  return {
    emails: total.emails + next.emails,
    links: total.links + next.links,
    phones: total.phones + next.phones,
    addresses: total.addresses + next.addresses,
    attributeLines: total.attributeLines + next.attributeLines,
  };
}
