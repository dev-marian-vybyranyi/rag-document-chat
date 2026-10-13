import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { createCareerIngestion, type CareerIngestionOptions } from '../../src/career/ingest.js';
import { defaultCareerLimits } from '../../src/career/limits.js';
import { chunks, documents } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { buildPdf } from '../helpers/pdf.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const resume = [
  'Alex Morgan',
  'Backend Engineer',
  'alex.morgan@example.com | +1 (415) 555-0134 | linkedin.com/in/alexmorgan',
  'Date of birth: 1990-04-02',
  'SUMMARY',
  'Engineer who likes reliable systems.',
  'EXPERIENCE',
  'Senior Engineer, Acme (2021-03 – 2024-06)',
  '- Cut p95 latency from 800 ms to 120 ms',
  'Engineer, Beta (2018-01 – 2021-02)',
  '- Built billing APIs',
  'SKILLS',
  'TypeScript, PostgreSQL, Docker',
].join('\n');

const posting = [
  'Backend Engineer',
  'About the role',
  'Join the payments team. Apply at jobs@acme.com.',
  'Requirements',
  '- 5+ years of Node',
  '- PostgreSQL',
  'Nice to have',
  '- Kubernetes',
].join('\n');

type Setup = Partial<Omit<CareerIngestionOptions, 'repository' | 'embedder'>>;

describe('resume and job posting ingestion', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(options: { embedder?: Embedder; repository?: typeof repository } & Setup = {}) {
    const { embedder = createFakeEmbedder(), ...rest } = options;
    const ingestion = createCareerIngestion({
      repository,
      embedder,
      logger: pino({ level: 'silent' }),
      embeddingModel: 'fake-model',
      ...rest,
    });
    const app = buildTestApp(db, { careerIngestion: ingestion, careerLimits: rest.limits });
    return { app, ingestion, embedder };
  }

  async function signedIn(app: ReturnType<typeof buildTestApp>, email = credentials.email) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  type Agent = Awaited<ReturnType<typeof signedIn>>;

  const addResume = async (agent: Agent, content: string | Buffer = resume, name = 'cv.txt') => {
    const res = await agent.post('/career/resume').attach('file', Buffer.from(content), name);
    return { res, id: res.body.document?.id as string };
  };

  const addJob = async (agent: Agent, content: string | Buffer = posting, name = 'backend.txt') => {
    const res = await agent.post('/career/jobs').attach('file', Buffer.from(content), name);
    return { res, id: res.body.document?.id as string };
  };

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);

  describe('a resume', () => {
    it('becomes a ready source with passages that know their section', async () => {
      const { app, ingestion } = setup();
      const agent = await signedIn(app);

      const { id } = await addResume(agent);
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({
        kind: 'resume',
        status: 'ready',
        error: null,
        embeddingModel: 'fake-model',
        pageCount: null,
        progressPhase: null,
        progressDone: null,
        progressTotal: null,
      });
      const rows = await chunkRows(id);
      expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i));
      expect(rows.map((r) => [r.section, r.content.split('\n')[0]])).toEqual([
        ['summary', 'Resume · Summary'],
        ['summary', 'Resume · Summary'],
        ['experience', 'Resume · Experience · Senior Engineer, Acme (2021-03 – 2024-06)'],
        ['experience', 'Resume · Experience · Engineer, Beta (2018-01 – 2021-02)'],
        ['skills', 'Resume · Skills'],
      ]);
      expect(rows.every((r) => r.path === null && r.startMs === null && r.speakers === null)).toBe(
        true,
      );
    });

    it('never stores contact details or personal attributes, and keeps the work history', async () => {
      const embedder = createFakeEmbedder();
      const { app, ingestion } = setup({ embedder });
      const agent = await signedIn(app);

      const { id } = await addResume(agent);
      await ingestion.idle();

      const stored = (await chunkRows(id)).map((r) => r.content).join('\n');
      const embedded = embedder.documentCalls.flat().join('\n');
      for (const text of [stored, embedded]) {
        expect(text).not.toMatch(/alex\.morgan@example\.com|555-0134|linkedin\.com|1990/);
        expect(text).toContain('[email] | [phone] | [link]');
        expect(text).toContain('- Cut p95 latency from 800 ms to 120 ms');
      }
    });

    it('is embedded exactly as it is stored', async () => {
      const embedder = createFakeEmbedder();
      const { app, ingestion } = setup({ embedder });
      const agent = await signedIn(app);

      const { id } = await addResume(agent);
      await ingestion.idle();

      expect(embedder.documentCalls.flat()).toEqual((await chunkRows(id)).map((r) => r.content));
    });

    it('reads headings and pages from a PDF, keeping its lines', async () => {
      const { app, ingestion } = setup();
      const agent = await signedIn(app);
      const pdf = buildPdf([
        ['Alex Morgan', 'EXPERIENCE', 'Engineer, Acme (2020 - 2023)', '- Built APIs'],
        ['- Ran on-call', 'SKILLS', 'TypeScript, Go'],
      ]);

      const { id } = await addResume(agent, pdf, 'cv.pdf');
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({ status: 'ready', pageCount: 2 });
      expect((await chunkRows(id)).map((r) => [r.section, r.page])).toEqual([
        ['summary', 1],
        ['experience', 1],
        ['experience', 2],
        ['skills', 2],
      ]);
    });
  });

  describe('a job posting', () => {
    it('is named by its number and keeps everything the posting says', async () => {
      const { app, ingestion } = setup();
      const agent = await signedIn(app);

      const first = await addJob(agent);
      const second = await addJob(agent, posting, 'platform.txt');
      await ingestion.idle();

      const rows = await chunkRows(first.id);
      expect(rows.map((r) => [r.section, r.content.split('\n')[0]])).toEqual([
        ['summary', 'Job #1 · backend · Summary'],
        ['summary', 'Job #1 · backend · Summary'],
        ['requirements', 'Job #1 · backend · Requirements'],
        ['nice_to_have', 'Job #1 · backend · Nice to have'],
      ]);
      expect(rows.map((r) => r.content).join('\n')).toContain('jobs@acme.com');
      expect((await chunkRows(second.id))[0]?.content.startsWith('Job #2 · platform')).toBe(true);
      expect(await documentRow(first.id)).toMatchObject({ kind: 'job_posting', status: 'ready' });
    });
  });

  describe('when something is wrong with the file', () => {
    let attempts = 0;
    const failure = async (
      options: { embedder?: Embedder } & Setup,
      content: string | Buffer,
      name = 'cv.txt',
      add: 'resume' | 'job' = 'resume',
    ) => {
      const { app, ingestion } = setup(options);
      const agent = await signedIn(app, `user${attempts++}@example.com`);
      const { id } = await (add === 'resume' ? addResume : addJob)(agent, content, name);
      await ingestion.idle();
      return { row: await documentRow(id), id };
    };

    it('fails a PDF with too many pages', async () => {
      const { row } = await failure(
        { limits: { ...defaultCareerLimits, maxResumePages: 2 } },
        buildPdf([['a'], ['b'], ['c']]),
        'cv.pdf',
      );

      expect(row).toMatchObject({
        status: 'failed',
        error: 'The PDF has too many pages (limit 2)',
      });
    });

    it('limits the pages of a job posting by its own limit', async () => {
      const limits = { ...defaultCareerLimits, maxJobPages: 1 };

      const posting = await failure({ limits }, buildPdf([['a'], ['b']]), 'job.pdf', 'job');
      const cv = await failure({ limits }, buildPdf([['a'], ['b']]), 'cv.pdf', 'resume');

      expect(posting.row).toMatchObject({
        status: 'failed',
        error: 'The PDF has too many pages (limit 1)',
      });
      expect(cv.row.status).toBe('ready');
    });

    it('fails a PDF with too much text, which only the indexing step can tell', async () => {
      const { row } = await failure(
        { limits: { ...defaultCareerLimits, maxJobCharacters: 50 } },
        buildPdf([['word '.repeat(30)]]),
        'job.pdf',
        'job',
      );

      expect(row).toMatchObject({
        status: 'failed',
        error: 'The job posting is too long (limit 50 characters)',
      });
    });

    it('fails a PDF that is a scan', async () => {
      const { row } = await failure({}, buildPdf([[], []]), 'cv.pdf');

      expect(row).toMatchObject({
        status: 'failed',
        error: 'The PDF has no selectable text (it may be a scan)',
      });
    });

    it('fails a resume that has nothing left after the personal details are removed', async () => {
      const { row } = await failure({}, 'Date of birth: 1990-04-02\nMarital status: single');

      expect(row).toMatchObject({
        status: 'failed',
        error: 'The resume contains no readable text',
      });
    });

    it('fails a file that would need more passages than the limit, before embedding it', async () => {
      const embedder = createFakeEmbedder();

      const { row } = await failure({ embedder, maxChunks: 2 }, resume);

      expect(row.status).toBe('failed');
      expect(row.error).toBe('The resume is too long to index (limit 2 passages)');
      expect(embedder.documentCalls).toEqual([]);
    });

    it('fails with the reason when the passages cannot be embedded, and stores nothing', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new EmbeddingError('rate_limited');
        },
        embedQuery: async () => [],
      };

      const { row, id } = await failure({ embedder }, resume);

      expect(row).toMatchObject({
        status: 'failed',
        error: new EmbeddingError('rate_limited').message,
        progressPhase: null,
      });
      expect(await chunkRows(id)).toEqual([]);
    });

    it('hides an unexpected failure behind a fixed message', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new Error('connect ECONNRESET 10.0.0.5:443');
        },
        embedQuery: async () => [],
      };

      const { row } = await failure({ embedder }, resume);

      expect(row).toMatchObject({
        status: 'failed',
        error: 'Something went wrong while processing the file.',
      });
    });
  });

  describe('while it works', () => {
    it('reports reading and then embedding, in steps of one group of passages', async () => {
      const long = [
        'SKILLS',
        ...Array.from({ length: 400 }, (_, i) => `Skill number ${i} ${'detail '.repeat(40)}`),
      ].join('\n');
      const seen: Array<{ phase: string | null; done: number | null; total: number | null }> = [];
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          const [row] = await db.select().from(documents);
          seen.push({
            phase: row!.progressPhase,
            done: row!.progressDone,
            total: row!.progressTotal,
          });
        },
      });
      const { app, ingestion } = setup({
        embedder,
        maxChunks: 1000,
        limits: { ...defaultCareerLimits, maxResumeCharacters: 1_000_000 },
      });
      const agent = await signedIn(app);

      const { id } = await addResume(agent, long);
      await ingestion.idle();

      const total = (await chunkRows(id)).length;
      expect(total).toBeGreaterThan(100);
      expect(seen).toEqual(
        Array.from({ length: Math.ceil(total / 100) }, (_, i) => ({
          phase: 'embedding',
          done: i * 100,
          total,
        })),
      );
    });

    it('moves from reading to embedding and counts the passages it embeds', async () => {
      const steps: Array<[string, number, number]> = [];
      const recording = {
        ...repository,
        setProgress: async (
          id: string,
          progress: { phase: string; done: number; total: number },
        ) => {
          steps.push([progress.phase, progress.done, progress.total]);
          await repository.setProgress(
            id,
            progress as Parameters<typeof repository.setProgress>[1],
          );
        },
      };
      const { app, ingestion } = setup({ repository: recording as typeof repository });
      const agent = await signedIn(app);

      const { id } = await addResume(agent);
      await ingestion.idle();

      const total = (await chunkRows(id)).length;
      expect(steps).toEqual([
        ['reading', 0, 0],
        ['embedding', 0, total],
        ['embedding', total, total],
      ]);
    });

    it('copes with the source being deleted while it is processed', async () => {
      const session: { agent?: Agent; id?: string } = {};
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          await session.agent!.delete(`/documents/${session.id}`);
        },
      });
      const logged: string[] = [];
      const logger = pino({ level: 'info' }, { write: (line: string) => void logged.push(line) });
      const { app, ingestion } = setup({ embedder, logger });
      session.agent = await signedIn(app);

      session.id = (await addResume(session.agent)).id;
      await ingestion.idle();

      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(chunks)).toEqual([]);
      expect(logged.some((line) => /deleted while it was being processed/.test(line))).toBe(true);
      expect(logged.some((line) => (JSON.parse(line) as { level: number }).level >= 40)).toBe(
        false,
      );
    });

    it('indexes several sources one after another, each for its own owner', async () => {
      const { app, ingestion } = setup();
      const ada = await signedIn(app);
      const grace = await signedIn(app, 'grace@example.com');
      const first = await addResume(ada);
      const second = await addResume(grace);
      const third = await addJob(grace);

      await ingestion.idle();

      const rows = await db.select().from(documents);
      expect(rows.map((r) => r.status)).toEqual(['ready', 'ready', 'ready']);
      expect(new Set(rows.map((r) => r.userId)).size).toBe(2);
      for (const id of [first.id, second.id, third.id]) {
        expect((await chunkRows(id)).length).toBeGreaterThan(0);
      }
    });
  });
});
