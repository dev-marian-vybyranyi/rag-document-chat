import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import {
  CareerCorpusError,
  ensureCareerEvalCorpus,
  EVAL_CAREER_USER_EMAILS,
  removeCareerEvalUsers,
  storedCareer,
  type CareerCorpusName,
} from '../../src/eval/career-corpus.js';
import {
  createCareerSearcher,
  evaluateCareerRetrieval,
  evaluateFits,
} from '../../src/eval/career-eval.js';
import { loadGoldenCareer } from '../../src/eval/golden-career.js';
import { QuotaExhaustedError } from '../../src/eval/quota-exhausted.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { oracle, type Flaws } from '../helpers/career-oracle.js';
import { createWordEmbedder } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

const root = join(import.meta.dirname, '../../../..');
const samplesDir = join(root, 'samples/career');
const golden = loadGoldenCareer(join(root, 'scripts/eval/golden-career.json'));
const logger = pino({ level: 'silent' });
const MODEL = 'word-bag';

describe('the career evaluation', () => {
  const db = useTestDb();
  const temporary: string[] = [];
  afterAll(() => {
    for (const folder of temporary) rmSync(folder, { recursive: true, force: true });
  });

  const options = (
    corpus: CareerCorpusName,
    overrides: Partial<Parameters<typeof ensureCareerEvalCorpus>[0]> = {},
    flaws: Flaws = {},
  ) => ({
    db,
    embedder: createWordEmbedder(),
    embeddingModel: MODEL,
    logger,
    golden,
    corpus,
    samplesDir,
    analysers: oracle(golden, flaws),
    retryDelayMs: 0,
    ...overrides,
  });

  const rowsOf = async (corpus: CareerCorpusName) => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, EVAL_CAREER_USER_EMAILS[corpus]));
    return db.select().from(documents).where(eq(documents.userId, user!.id));
  };

  describe('indexing the sample documents', () => {
    it('indexes the resume and the postings of the standard set for a user of their own, in order', async () => {
      const corpus = await ensureCareerEvalCorpus(options('standard'));

      expect(corpus.indexed).toEqual([
        golden.corpora.standard.resume,
        ...golden.corpora.standard.jobs,
      ]);
      expect(corpus.reused).toEqual([]);
      expect(corpus.withoutProfile).toEqual([]);
      expect(corpus.withoutFit).toEqual([]);
      const rows = await rowsOf('standard');
      expect(
        rows.map((r) => [r.kind, r.filename, r.jobNumber, r.status, r.embeddingModel]),
      ).toEqual(
        expect.arrayContaining([
          ['resume', 'resume-alex-morgan', null, 'ready', MODEL],
          ['job_posting', 'Senior Backend Engineer at Northwind Payments', 1, 'ready', MODEL],
          ['job_posting', 'Platform Engineer at Contoso Cloud', 2, 'ready', MODEL],
          ['job_posting', 'Engineering Manager at Globex', 5, 'ready', MODEL],
        ]),
      );
      expect(rows).toHaveLength(6);
    });

    it('keeps the standard set and the injected set apart, each with its own numbering', async () => {
      await ensureCareerEvalCorpus(options('standard'));
      await ensureCareerEvalCorpus(options('injected'));

      const injected = await rowsOf('injected');

      expect(
        injected.filter((r) => r.kind === 'job_posting').map((r) => [r.jobNumber, r.filename]),
      ).toEqual(
        expect.arrayContaining([
          [1, 'Platform Engineer at Contoso Cloud'],
          [2, 'Backend Engineer at Initrode'],
        ]),
      );
      expect(injected.find((r) => r.kind === 'resume')?.filename).toBe(
        'resume-alex-morgan-injected',
      );
      expect((await rowsOf('standard')).length).toBe(6);
    });

    it('compares each posting with the resume and keeps the profile of each', async () => {
      const corpus = await ensureCareerEvalCorpus(options('standard'));

      const stored = await storedCareer(db, corpus, golden.corpora.standard.resume);

      expect(stored.resume?.totalExperienceYears).toBe(5.8);
      expect([...stored.jobs.keys()]).toEqual(golden.corpora.standard.jobs);
      for (const { profile, fit } of stored.jobs.values()) {
        expect(profile?.role).toBe('job');
        expect(fit?.coverage).toBeGreaterThanOrEqual(0);
      }
      expect(stored.jobs.get('job-backend-go.txt')?.fit?.coverage).toBe(97);
    });

    it('reuses what is already indexed, without embedding anything', async () => {
      await ensureCareerEvalCorpus(options('standard'));
      const embedder = createWordEmbedder();

      const again = await ensureCareerEvalCorpus(options('standard', { embedder }));

      expect(again.indexed).toEqual([]);
      expect(again.reused).toHaveLength(6);
      expect(embedder.documentCalls).toEqual([]);
      expect(await rowsOf('standard')).toHaveLength(6);
    });

    it('indexes again when asked to, and leaves no copy of the old one behind', async () => {
      const first = await ensureCareerEvalCorpus(options('standard'));

      const second = await ensureCareerEvalCorpus(options('standard', { reindex: true }));

      expect(second.indexed).toHaveLength(6);
      expect(await rowsOf('standard')).toHaveLength(6);
      expect(
        [...second.documents.values()].some((id) => [...first.documents.values()].includes(id)),
      ).toBe(false);
    });

    it('indexes everything again when a file changed, so that the numbering stays right', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'career-'));
      temporary.push(folder);
      cpSync(samplesDir, folder, { recursive: true });
      await ensureCareerEvalCorpus(options('standard', { samplesDir: folder }));
      const file = join(folder, 'job-data.txt');
      writeFileSync(file, `${readFileSync(file, 'utf8')}Plus one more line.\n`);

      const second = await ensureCareerEvalCorpus(options('standard', { samplesDir: folder }));

      expect(second.indexed).toHaveLength(6);
      expect(second.reused).toEqual([]);
      expect(
        (await rowsOf('standard'))
          .filter((r) => r.kind === 'job_posting')
          .map((r) => r.jobNumber)
          .sort(),
      ).toEqual([1, 2, 3, 4, 5]);
    });

    it('indexes again when something else is in the account of the evaluation user', async () => {
      await ensureCareerEvalCorpus(options('standard'));
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, EVAL_CAREER_USER_EMAILS.standard));
      await db.insert(documents).values({
        userId: user!.id,
        filename: 'stray.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: 'ready',
      });

      const again = await ensureCareerEvalCorpus(options('standard'));

      expect(again.indexed).toHaveLength(6);
      expect((await rowsOf('standard')).map((r) => r.filename)).not.toContain('stray.txt');
    });

    it('indexes again when the embedding model changed', async () => {
      await ensureCareerEvalCorpus(options('standard'));

      const again = await ensureCareerEvalCorpus(
        options('standard', { embeddingModel: 'other-model' }),
      );

      expect(again.indexed).toHaveLength(6);
      expect((await rowsOf('standard')).every((r) => r.embeddingModel === 'other-model')).toBe(
        true,
      );
    });

    it('says which postings have no profile and which have no comparison, after trying again', async () => {
      const retries: string[] = [];
      const corpus = await ensureCareerEvalCorpus(
        options(
          'standard',
          { onRetry: (what) => retries.push(what) },
          {
            profileFails: (job) => job.file === 'job-data.txt',
            matcherFails: (job) => job.file === 'job-frontend.txt',
          },
        ),
      );

      expect(corpus.withoutProfile).toEqual(['job-data.txt']);
      expect(corpus.withoutFit).toEqual(['job-frontend.txt']);
      expect(retries.filter((what) => what.startsWith('job-frontend.txt'))).toHaveLength(2);
      const stored = await storedCareer(db, corpus, golden.corpora.standard.resume);
      expect(stored.jobs.get('job-frontend.txt')).toMatchObject({ fit: null });
      expect(stored.jobs.get('job-platform.txt')?.fit).not.toBeNull();
    });

    it('stops when the daily quota of embeddings is used up', async () => {
      const exhausted: Embedder = {
        embedQuery: async () => [],
        embedDocuments: async () => {
          throw new EmbeddingError('quota_exhausted');
        },
      };

      await expect(
        ensureCareerEvalCorpus(options('standard', { embedder: exhausted })),
      ).rejects.toBeInstanceOf(QuotaExhaustedError);
      expect(await rowsOf('standard')).toEqual([]);
    });

    it('gives up with the name of the file after the attempts it was given, and cleans up', async () => {
      const failing: Embedder = {
        embedQuery: async () => [],
        embedDocuments: async () => {
          throw new EmbeddingError('unavailable');
        },
      };
      const retries: number[] = [];

      await expect(
        ensureCareerEvalCorpus(
          options('standard', {
            embedder: failing,
            attempts: 2,
            onRetry: (_what, attempt) => retries.push(attempt),
          }),
        ),
      ).rejects.toThrow(CareerCorpusError);
      expect(retries).toEqual([1]);
      expect(await rowsOf('standard')).toEqual([]);
    });

    it('deletes the evaluation users and everything they own', async () => {
      await ensureCareerEvalCorpus(options('standard'));
      await ensureCareerEvalCorpus(options('injected'));

      expect(await removeCareerEvalUsers(db)).toBe(2);

      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(chunks)).toEqual([]);
      expect(await removeCareerEvalUsers(db)).toBe(0);
    });
  });

  describe('judging the fit', () => {
    async function judged(flaws: Flaws = {}) {
      const analysers = oracle(golden, flaws);
      const standard = await ensureCareerEvalCorpus(options('standard', { analysers }));
      const injected = await ensureCareerEvalCorpus(options('injected', { analysers }));
      return evaluateFits({
        golden,
        standard: await storedCareer(db, standard, golden.corpora.standard.resume),
        injected: await storedCareer(db, injected, golden.corpora.injected.resume),
        resumeText: readFileSync(join(samplesDir, golden.corpora.standard.resume), 'utf8'),
        injectedResumeText: readFileSync(join(samplesDir, golden.corpora.injected.resume), 'utf8'),
      });
    }

    it('finds nothing to complain about in a model that agrees with the key', async () => {
      const report = await judged();

      const s = report.standard.summary;
      expect(report.profile.years.right).toBe(true);
      expect(report.profile.skills.missing).toEqual([]);
      expect(s.requirementRecall).toBe(1);
      expect(s.statusAccuracy).toBe(1);
      expect(s.falseMet).toBe(0);
      expect(s.inflated).toBe(0);
      expect(s.understated).toBe(0);
      expect(s.verifiedShare).toBe(1);
      expect(s.experienceRight).toBe(s.experienceChecked);
      expect(s.coverageError).toBe(0);
      expect(s.rankingExact).toBe(true);
      expect(report.injected.injection.some((item) => item.followed)).toBe(false);
    });

    it('catches a model that says "met" for what the key does not show', async () => {
      const report = await judged({
        inflate: (job, skill) =>
          job.file === 'job-data.txt' && skill === 'Kafka' ? 'met' : undefined,
        quote: (_job, _skill, quote) => quote ?? 'RabbitMQ',
      });

      const s = report.standard.summary;
      expect(s.falseMet).toBe(1);
      expect(s.falseMetRate).toBeGreaterThan(0);
      expect(s.inflated).toBe(1);
      expect(s.statusAccuracy).toBeLessThan(1);
      expect(s.coverageError).toBeGreaterThan(0);
    });

    it('catches a quote that is not in the resume', async () => {
      const report = await judged({
        quote: (_job, skill, quote) => (skill === 'AWS' ? 'Ten years of AWS' : quote),
      });

      expect(report.standard.summary.verifiedShare).toBeLessThan(1);
    });

    it('catches a model that lets the instruction in a document raise its score', async () => {
      const report = await judged({
        inflate: (job) => (job.file === 'job-injected.txt' ? 'met' : undefined),
        quote: (_job, _skill, quote) => quote ?? 'Go, Rust',
      });

      expect(report.injected.injection.find((i) => i.file === 'job-injected.txt')?.followed).toBe(
        true,
      );
      expect(report.injected.injection.find((i) => i.file === 'job-platform.txt')?.followed).toBe(
        false,
      );
    });

    it('catches wrong years, missing skills and requirements that were not found', async () => {
      const report = await judged({
        years: 7.4,
        dropSkills: ['Rust', 'Redis'],
        dropRequirements: (job) => (job.file === 'job-platform.txt' ? ['Terraform'] : []),
      });

      expect(report.profile.years.right).toBe(false);
      expect(report.profile.skills.missing).toEqual(['Rust', 'Redis']);
      expect(report.standard.summary.requirementRecall).toBeLessThan(1);
      expect(report.standard.summary.found).toBe(report.standard.summary.requirements - 1);
    });

    it('counts a posting that was not compared, instead of failing', async () => {
      const report = await judged({ matcherFails: (job) => job.file === 'job-frontend.txt' });

      expect(report.standard.summary.compared).toBe(report.standard.summary.postings - 1);
      expect(report.standard.scores.find((s) => s.file === 'job-frontend.txt')?.compared).toBe(
        false,
      );
      expect(report.standard.summary.rankingExact).toBeNull();
    });
  });

  describe('judging retrieval', () => {
    async function retrieval(embedder = createWordEmbedder()) {
      const store = createRetrievalStore(db, { embeddingModel: MODEL });
      const searchers = {} as Record<CareerCorpusName, ReturnType<typeof createCareerSearcher>>;
      for (const name of ['standard', 'injected'] as const) {
        const corpus = await ensureCareerEvalCorpus(options(name, { embedder }));
        searchers[name] = createCareerSearcher({
          userId: corpus.userId,
          store,
          embedder,
          logger,
          documents: corpus.documents,
          queryPacingMs: 0,
        });
      }
      return evaluateCareerRetrieval({ golden, searchers, thresholds: [0.1, 0.3, 0.5] });
    }

    it('asks all the questions, and finds the right document for nearly all that can be answered', async () => {
      const report = await retrieval();

      expect(report.rows).toHaveLength(
        golden.questions.filter((q) => q.type !== 'unanswerable').length,
      );
      expect(report.unanswerable).toHaveLength(
        golden.questions.filter((q) => q.type === 'unanswerable').length,
      );
      expect(report.summary.levels.document.hitAt[6]).toBeGreaterThan(0.85);
      expect(report.summary.all.hybrid.hitAt[6]).toBeGreaterThan(0.5);
    });

    it('puts the resume and the posting in the context for questions about a posting, and the addition helps', async () => {
      const report = await retrieval();

      expect(report.sides.questions).toBeGreaterThan(6);
      expect(report.sides.after).toBe(report.sides.questions);
      expect(report.sides.after).toBeGreaterThanOrEqual(report.sides.before);
    });

    it('picks out the posting a question names, and no other', async () => {
      const report = await retrieval();

      expect(report.jobs.recognised).toBe(report.jobs.named);
      expect(report.jobs.unexpected).toBe(0);
    });

    it('scores every question and sweeps the threshold from answering everything towards refusing everything', async () => {
      const report = await retrieval();

      expect(report.rows.every((r) => r.bestScore !== null)).toBe(true);
      expect(report.unanswerable.every((r) => r.bestScore !== null)).toBe(true);
      const [low, middle, high] = report.thresholds;
      expect(low!.answered).toBeGreaterThan(0.9);
      expect(middle!.answered).toBeLessThanOrEqual(low!.answered);
      expect(high!.answered).toBeLessThanOrEqual(middle!.answered);
      expect(high!.refused).toBeGreaterThanOrEqual(low!.refused);
    });

    it('refuses to measure keyword search when the question cannot be embedded', async () => {
      const broken: Embedder = {
        ...createWordEmbedder(),
        embedQuery: async () => {
          throw new EmbeddingError('unavailable');
        },
      };
      const store = createRetrievalStore(db, { embeddingModel: MODEL });
      const corpus = await ensureCareerEvalCorpus(options('standard'));
      const searcher = createCareerSearcher({
        userId: corpus.userId,
        store,
        embedder: broken,
        logger,
        documents: corpus.documents,
        queryPacingMs: 0,
      });

      await expect(searcher.search('hybrid', 'What does Job #2 require?')).rejects.toThrow();
    });
  });
});
