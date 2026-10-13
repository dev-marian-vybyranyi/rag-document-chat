import type { Logger } from 'pino';
import { EmbeddingError, type Embedder } from '../ai/embeddings.js';
import type {
  DocumentRepository,
  DocumentWithChunkCount,
  NewChunk,
} from '../documents/repository.js';
import { chunkSections } from './chunker.js';
import {
  byFitness,
  fitSections,
  overviewSections,
  sharedGaps,
  type ComparedPosting,
  type SharedGap,
} from './fit-text.js';
import { careerLabel } from './labels.js';
import type { FitMatcher } from './matcher.js';
import type { CareerProfileService } from './regenerate.js';
import { bodyOfPassage } from './regenerate.js';
import { summarizeProfile } from './summary.js';
import type { Fit, JobProfile } from './types.js';
import type { TextSection } from './sections.js';

export type FitStatus =
  | 'done'
  | 'fresh'
  | 'not_found'
  | 'not_ready'
  | 'no_resume'
  | 'other_model'
  | 'no_profile'
  | 'unavailable';

export interface AnalyzeOptions {
  force?: boolean;
  buildProfile?: boolean;
}

export interface PostingView {
  id: string;
  jobNumber: number | null;
  filename: string;
  status: DocumentWithChunkCount['status'];
  error: string | null;
  profile: ReturnType<typeof summarizeProfile>;
  fit: Fit | null;
}

export interface CareerOverview {
  resume: {
    id: string;
    filename: string;
    status: DocumentWithChunkCount['status'];
    error: string | null;
    profile: ReturnType<typeof summarizeProfile>;
  } | null;
  postings: PostingView[];
  compared: number;
  gaps: SharedGap[];
}

export interface FitService {
  analyze(jobId: string, userId: string, options?: AnalyzeOptions): Promise<{ status: FitStatus }>;
  schedule(documentId: string, userId: string): void;
  afterDelete(document: { kind: string; userId: string }): Promise<void>;
  overview(userId: string): Promise<CareerOverview>;
  idle(): Promise<void>;
}

export function createFitService({
  repository,
  embedder,
  matcher,
  profiles,
  logger,
  embeddingModel,
}: {
  repository: DocumentRepository;
  embedder: Embedder;
  matcher: FitMatcher;
  profiles: CareerProfileService;
  logger: Logger;
  embeddingModel?: string;
}): FitService {
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };

  const usable = (document: DocumentWithChunkCount) =>
    embeddingModel === undefined || document.embeddingModel === embeddingModel;

  async function sources(userId: string) {
    const all = await repository.listByUser(userId);
    return {
      resume: all.find((d) => d.kind === 'resume'),
      jobs: all
        .filter((d) => d.kind === 'job_posting')
        .sort((a, b) => (a.jobNumber ?? 0) - (b.jobNumber ?? 0)),
    };
  }

  async function embedSections(
    sections: TextSection[],
    label: string,
  ): Promise<Array<Omit<NewChunk, 'ordinal'>> | null> {
    const passages = chunkSections(sections, { label });
    if (passages.length === 0) return [];
    try {
      const vectors = await embedder.embedDocuments(passages.map((passage) => passage.content));
      return passages.map((passage, i) => ({
        page: null,
        section: passage.section,
        content: passage.content,
        tokenCount: passage.tokenCount,
        embedding: vectors[i]!,
      }));
    } catch (error) {
      if (error instanceof EmbeddingError) return null;
      throw error;
    }
  }

  async function analyzeOne(
    job: DocumentWithChunkCount,
    resume: DocumentWithChunkCount,
    { buildProfile = false }: AnalyzeOptions,
  ): Promise<FitStatus> {
    if (!usable(resume) || !usable(job)) return 'other_model';

    let profile: JobProfile | null = job.profile?.role === 'job' ? job.profile : null;
    if (profile === null && buildProfile) {
      const built = await profiles.regenerate(job.id, job.userId);
      if (built.status !== 'done')
        return built.status === 'unavailable' ? 'unavailable' : 'not_ready';
      const reloaded = await repository.findForUser(job.id, job.userId);
      profile = reloaded?.profile?.role === 'job' ? reloaded.profile : null;
    }
    if (
      profile === null ||
      (profile.requirements.length === 0 && profile.minYearsExperience === null)
    ) {
      return 'no_profile';
    }

    const resumeText = (await repository.careerPassages(resume.id, resume.userId))
      .map(bodyOfPassage)
      .join('\n');
    const fit = await matcher.match({
      job: profile,
      resumeText,
      resumeId: resume.id,
      resumeYears: resume.profile?.role === 'resume' ? resume.profile.totalExperienceYears : null,
    });
    if (fit === null) return 'unavailable';

    const chunks = await embedSections(fitSections(fit), careerLabel(job));
    if (chunks === null) return 'unavailable';
    if (!(await repository.findForUser(resume.id, resume.userId))) return 'no_resume';

    await repository.replaceFit({ documentId: job.id, userId: job.userId, fit, chunks });
    return 'done';
  }

  const isCurrent = (job: DocumentWithChunkCount, resume: DocumentWithChunkCount) =>
    job.fit !== null && job.fit.resumeId === resume.id;

  async function rebuildOverview(userId: string): Promise<void> {
    const { resume, jobs } = await sources(userId);
    if (!resume || resume.status !== 'ready' || !usable(resume)) return;

    const ready = jobs.filter((job) => job.status === 'ready');
    const compared: ComparedPosting[] = ready.flatMap((job) =>
      job.fit !== null && isCurrent(job, resume)
        ? [{ jobNumber: job.jobNumber, name: job.filename, fit: job.fit }]
        : [],
    );
    const uncompared = ready
      .filter((job) => !isCurrent(job, resume))
      .map((job) => ({ jobNumber: job.jobNumber, name: job.filename }));

    const chunks = await embedSections(overviewSections(compared, uncompared), 'Resume');
    if (chunks === null) {
      logger.warn({ userId }, 'the overview of the postings could not be embedded');
      return;
    }
    await repository.replaceOverview({ documentId: resume.id, userId, chunks });
  }

  async function analyzeAndSummarize(
    jobId: string,
    userId: string,
    options: AnalyzeOptions,
  ): Promise<FitStatus> {
    const { resume, jobs } = await sources(userId);
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) return 'not_found';
    if (job.status !== 'ready') return 'not_ready';
    if (!resume || resume.status !== 'ready') return 'no_resume';
    if (!options.force && isCurrent(job, resume)) return 'fresh';

    const status = await analyzeOne(job, resume, options);
    if (status === 'done') await rebuildOverview(userId);
    return status;
  }

  async function analyzeStale(userId: string): Promise<void> {
    const { resume, jobs } = await sources(userId);
    if (!resume || resume.status !== 'ready') return;
    let changed = false;
    for (const job of jobs) {
      if (job.status !== 'ready' || isCurrent(job, resume)) continue;
      if ((await analyzeOne(job, resume, {})) === 'done') changed = true;
    }
    if (changed) await rebuildOverview(userId);
  }

  async function clearFits(userId: string): Promise<void> {
    const { jobs } = await sources(userId);
    for (const job of jobs) {
      if (job.fit === null) continue;
      await repository.replaceFit({ documentId: job.id, userId, fit: null, chunks: [] });
    }
  }

  return {
    analyze(jobId, userId, options = {}) {
      return serialized(async () => ({
        status: await analyzeAndSummarize(jobId, userId, options),
      }));
    },

    schedule(documentId, userId) {
      void serialized(async () => {
        const { resume, jobs } = await sources(userId);
        if (resume?.id === documentId) return analyzeStale(userId);
        if (jobs.some((job) => job.id === documentId)) {
          await analyzeAndSummarize(documentId, userId, {});
        }
      }).catch((error: unknown) => logger.error({ err: error }, 'analysing the fit failed'));
    },

    afterDelete({ kind, userId }) {
      return serialized(async () => {
        if (kind === 'resume') await clearFits(userId);
        else if (kind === 'job_posting') await rebuildOverview(userId);
      }).catch((error: unknown) =>
        logger.error({ err: error }, 'updating the fits after a deletion failed'),
      );
    },

    async overview(userId) {
      const { resume, jobs } = await sources(userId);
      const current = (job: DocumentWithChunkCount) =>
        resume !== undefined && job.fit !== null && isCurrent(job, resume) ? job.fit : null;

      const compared: ComparedPosting[] = jobs.flatMap((job) => {
        const fit = current(job);
        return fit === null ? [] : [{ jobNumber: job.jobNumber, name: job.filename, fit }];
      });
      const order = new Map(
        [...compared].sort(byFitness).map((posting, i) => [posting.jobNumber, i] as const),
      );
      const view = (job: DocumentWithChunkCount): PostingView => ({
        id: job.id,
        jobNumber: job.jobNumber,
        filename: job.filename,
        status: job.status,
        error: job.error,
        profile: summarizeProfile(job.profile),
        fit: current(job),
      });
      const rank = (job: DocumentWithChunkCount) =>
        current(job) === null ? Infinity : (order.get(job.jobNumber) ?? Infinity);

      return {
        resume: resume
          ? {
              id: resume.id,
              filename: resume.filename,
              status: resume.status,
              error: resume.error,
              profile: summarizeProfile(resume.profile),
            }
          : null,
        postings: [...jobs]
          .sort((a, b) => rank(a) - rank(b) || (a.jobNumber ?? 0) - (b.jobNumber ?? 0))
          .map(view),
        compared: compared.length,
        gaps: sharedGaps(compared),
      };
    },

    idle: () => tail.then(() => undefined),
  };
}
