import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import { createFitService } from '../career/fit-service.js';
import { createCareerIngestion } from '../career/ingest.js';
import type { JobProfileExtractor } from '../career/job-profile.js';
import type { FitMatcher } from '../career/matcher.js';
import { createCareerProfileService } from '../career/regenerate.js';
import type { ResumeProfileExtractor } from '../career/resume-profile.js';
import type { Fit, JobProfile, ResumeProfile } from '../career/types.js';
import type { Database } from '../db/client.js';
import { documents, users } from '../db/schema.js';
import { detectFileType } from '../documents/file-types.js';
import { createDocumentRepository } from '../documents/repository.js';
import type { GoldenCareer, JobKey } from './golden-career.js';
import { QuotaExhaustedError } from './quota-exhausted.js';

export type CareerCorpusName = 'standard' | 'injected';

export const EVAL_CAREER_USER_EMAILS: Record<CareerCorpusName, string> = {
  standard: 'eval-career@rag-chat.invalid',
  injected: 'eval-career-injected@rag-chat.invalid',
};
const UNUSABLE_PASSWORD_HASH = 'not-a-password-hash';
const QUOTA_EXHAUSTED_MESSAGE = new EmbeddingError('quota_exhausted').message;

export class CareerCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CareerCorpusError';
  }
}

export interface CareerCorpusResult {
  userId: string;
  documents: Map<string, string>;
  indexed: string[];
  reused: string[];
  withoutProfile: string[];
  withoutFit: string[];
}

export interface CareerAnalysers {
  resumeProfiles: ResumeProfileExtractor;
  jobProfiles: JobProfileExtractor;
  matcher: FitMatcher;
}

interface CorpusOptions {
  db: Database;
  embedder: Embedder;
  embeddingModel?: string;
  logger: Logger;
  golden: GoldenCareer;
  corpus: CareerCorpusName;
  samplesDir: string;
  analysers: CareerAnalysers;
  reindex?: boolean;
  attempts?: number;
  retryDelayMs?: number;
  onRetry?: (what: string, attempt: number, error: string) => void;
}

export const jobTitleOf = (job: JobKey): string => `${job.title} at ${job.company}`;
export const resumeNameOf = (file: string): string => file.replace(/\.[^.]+$/, '');

async function evalUser(db: Database, corpus: CareerCorpusName) {
  const email = EVAL_CAREER_USER_EMAILS[corpus];
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ email, passwordHash: UNUSABLE_PASSWORD_HASH })
    .returning();
  return created!;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function ensureCareerEvalCorpus(options: CorpusOptions): Promise<CareerCorpusResult> {
  const {
    db,
    embedder,
    embeddingModel,
    logger,
    golden,
    corpus,
    samplesDir,
    analysers,
    reindex = false,
    attempts = 3,
    retryDelayMs = 65_000,
    onRetry,
  } = options;
  const repository = createDocumentRepository(db);
  const user = await evalUser(db, corpus);
  const wanted = golden.corpora[corpus];
  const jobKeys = new Map(golden.jobs.map((job) => [job.file, job]));

  const profiles = createCareerProfileService({
    repository,
    embedder,
    resumeProfiles: analysers.resumeProfiles,
    jobProfiles: analysers.jobProfiles,
    embeddingModel,
  });
  const fits = createFitService({
    repository,
    embedder,
    matcher: analysers.matcher,
    profiles,
    logger,
    embeddingModel,
  });
  const ingestion = createCareerIngestion({
    repository,
    embedder,
    logger,
    embeddingModel,
    resumeProfiles: analysers.resumeProfiles,
    jobProfiles: analysers.jobProfiles,
    afterIndexed: (document) => fits.schedule(document.id, document.userId),
  });

  const files = [wanted.resume, ...wanted.jobs].map((file) => ({
    file,
    content: readFileSync(join(samplesDir, file)),
    name: file === wanted.resume ? resumeNameOf(file) : jobTitleOf(jobKeys.get(file)!),
    kind: file === wanted.resume ? ('resume' as const) : ('job_posting' as const),
  }));

  const result: CareerCorpusResult = {
    userId: user.id,
    documents: new Map(),
    indexed: [],
    reused: [],
    withoutProfile: [],
    withoutFit: [],
  };

  const clear = async () => {
    for (const doc of await db.select().from(documents).where(eq(documents.userId, user.id))) {
      await repository.deleteForUser(doc.id, user.id);
    }
    result.documents.clear();
  };

  const existing = await db.select().from(documents).where(eq(documents.userId, user.id));
  const intact =
    !reindex &&
    existing.length === files.length &&
    files.every((entry) => {
      const row = existing.find((doc) => doc.filename === entry.name && doc.kind === entry.kind);
      return (
        row !== undefined &&
        row.status === 'ready' &&
        row.sizeBytes === entry.content.length &&
        (embeddingModel === undefined || row.embeddingModel === embeddingModel)
      );
    });

  if (intact) {
    for (const entry of files) {
      result.documents.set(entry.file, existing.find((doc) => doc.filename === entry.name)!.id);
      result.reused.push(entry.file);
    }
  } else {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await clear();
      let failed: string | null = null;

      for (const entry of files) {
        const type = detectFileType(entry.file)!;
        const input = {
          userId: user.id,
          filename: entry.name,
          mimeType: type.mimeType,
          sizeBytes: entry.content.length,
        };
        const document =
          entry.kind === 'resume'
            ? await repository.create({ ...input, kind: 'resume' })
            : await repository.createJobPosting(input);
        ingestion.enqueue({ document, type, content: entry.content });
        await ingestion.idle();
        await fits.idle();
        result.documents.set(entry.file, document.id);

        const [after] = await db.select().from(documents).where(eq(documents.id, document.id));
        if (after?.status !== 'ready') {
          failed = entry.file;
          lastError = after?.error ?? lastError;
          break;
        }
      }

      if (failed === null) break;
      if (lastError === QUOTA_EXHAUSTED_MESSAGE) {
        await clear();
        throw new QuotaExhaustedError();
      }
      if (attempt < attempts) {
        onRetry?.(failed, attempt, lastError);
        await sleep(retryDelayMs);
      } else {
        await clear();
        throw new CareerCorpusError(`${failed}: ${lastError}`);
      }
    }
    result.indexed.push(...files.map((entry) => entry.file));
  }

  const resumeId = result.documents.get(wanted.resume)!;
  const stored = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if ((await stored(resumeId))?.profile) break;
    await profiles.regenerate(resumeId, user.id);
    if (!(await stored(resumeId))?.profile && attempt < attempts) {
      onRetry?.(`${wanted.resume} profile`, attempt, 'the profile could not be made');
      await sleep(retryDelayMs);
    }
  }
  if (!(await stored(resumeId))?.profile) result.withoutProfile.push(wanted.resume);

  for (const file of wanted.jobs) {
    const id = result.documents.get(file)!;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const row = await stored(id);
      if (row?.profile && row.fit) break;
      await fits.analyze(id, user.id, { buildProfile: true });
      const after = await stored(id);
      if (after?.profile && after.fit) break;
      if (attempt < attempts) {
        onRetry?.(`${file} comparison`, attempt, 'the comparison could not be made');
        await sleep(retryDelayMs);
      }
    }
    const final = await stored(id);
    if (!final?.profile) result.withoutProfile.push(file);
    else if (!final.fit) result.withoutFit.push(file);
  }
  await fits.idle();
  return result;
}

export interface StoredCareer {
  resume: ResumeProfile | null;
  jobs: Map<string, { profile: JobProfile | null; fit: Fit | null }>;
}

export async function storedCareer(
  db: Database,
  corpus: CareerCorpusResult,
  resumeFile: string,
): Promise<StoredCareer> {
  const rows = await db.select().from(documents).where(eq(documents.userId, corpus.userId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: StoredCareer = { resume: null, jobs: new Map() };
  for (const [file, id] of corpus.documents) {
    const row = byId.get(id);
    if (file === resumeFile) {
      result.resume = row?.profile?.role === 'resume' ? row.profile : null;
    } else {
      result.jobs.set(file, {
        profile: row?.profile?.role === 'job' ? row.profile : null,
        fit: row?.fit ?? null,
      });
    }
  }
  return result;
}

export async function removeCareerEvalUsers(db: Database): Promise<number> {
  let removed = 0;
  for (const email of Object.values(EVAL_CAREER_USER_EMAILS)) {
    removed += (await db.delete(users).where(eq(users.email, email)).returning({ id: users.id }))
      .length;
  }
  return removed;
}
