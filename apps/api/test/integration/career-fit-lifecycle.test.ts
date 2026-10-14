import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { createFitService } from '../../src/career/fit-service.js';
import { createCareerIngestion } from '../../src/career/ingest.js';
import type { MatchInput } from '../../src/career/matcher.js';
import { createCareerProfileService } from '../../src/career/regenerate.js';
import type { Fit, JobProfile, ResumeProfile } from '../../src/career/types.js';
import { chunks, documents } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const resumeText = [
  'Alex Morgan',
  'alex@example.com | +1 (415) 555-0134',
  'SKILLS',
  'Go, Rust, Docker',
].join('\n');

const posting = (title: string, ...requirements: string[]) =>
  [title, 'Requirements', ...requirements.map((r) => `- ${r}`)].join('\n');

describe('analysing the fit of a resume and its postings', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(options: { hookThrows?: boolean } = {}) {
    const state = {
      resumeYears: 6 as number | null,
      matcherFails: false,
      onMatch: undefined as undefined | (() => Promise<void>),
      embeddingFails: false,
      noJobProfile: new Set<string>(),
      coverage: new Map<string, number>(),
      matches: [] as Array<{
        title: string | null;
        resumeId: string;
        resumeYears: number | null;
        resumeText: string;
      }>,
      profileCalls: [] as string[],
    };

    const baseEmbedder = createFakeEmbedder();
    const embedder: Embedder = {
      embedQuery: (text) => baseEmbedder.embedQuery(text),
      embedDocuments: async (texts) => {
        if (state.embeddingFails) throw new EmbeddingError('rate_limited');
        return baseEmbedder.embedDocuments(texts);
      },
    };

    const resumeProfiles = {
      extract: async (): Promise<ResumeProfile> => ({
        role: 'resume',
        headline: null,
        skills: [{ name: 'Go', quote: 'Go, Rust, Docker' }],
        roles: [],
        education: [],
        totalExperienceYears: state.resumeYears,
      }),
    };
    const jobProfiles = {
      extract: async ({ text }: { name: string; text: string }): Promise<JobProfile | null> => {
        state.profileCalls.push(text);
        const [title = ''] = text.split('\n');
        if (state.noJobProfile.has(title)) return null;
        return {
          role: 'job',
          title,
          company: null,
          minYearsExperience: null,
          requirements: text
            .split('\n')
            .filter((line) => line.startsWith('- '))
            .map((line, i) => ({
              id: `r${i + 1}`,
              text: line.slice(2),
              skill: line.slice(2),
              importance: 'must' as const,
              quote: line.slice(2),
            })),
          responsibilities: [],
        };
      },
    };
    const matcher = {
      match: async ({
        job,
        resumeId,
        resumeYears,
        resumeText: text,
      }: MatchInput): Promise<Fit | null> => {
        state.matches.push({ title: job.title, resumeId, resumeYears, resumeText: text });
        await state.onMatch?.();
        if (state.matcherFails) return null;
        const coverage = state.coverage.get(job.title ?? '') ?? 50;
        return {
          resumeId,
          analyzedAt: `call-${state.matches.length}`,
          coverage,
          mustCoverage: coverage,
          requirements: job.requirements.map((r, i) => ({
            requirementId: r.id,
            text: r.text,
            skill: r.skill,
            importance: r.importance,
            status: i === 0 ? ('met' as const) : ('not_shown' as const),
            quote: i === 0 ? 'Go, Rust, Docker' : null,
            note: '',
          })),
        };
      },
    };

    const logger = pino({ level: 'silent' });
    const profiles = createCareerProfileService({
      repository,
      embedder,
      resumeProfiles,
      jobProfiles,
      embeddingModel: 'fake-model',
    });
    const fits = createFitService({
      repository,
      embedder,
      matcher,
      profiles,
      logger,
      embeddingModel: 'fake-model',
    });
    const ingestion = createCareerIngestion({
      repository,
      embedder,
      logger,
      embeddingModel: 'fake-model',
      resumeProfiles,
      jobProfiles,
      afterIndexed: (document) => {
        if (options.hookThrows) throw new Error('hook failed');
        fits.schedule(document.id, document.userId);
      },
    });
    const app = buildTestApp(db, {
      careerIngestion: ingestion,
      careerProfiles: profiles,
      careerFits: fits,
    });

    const settle = async () => {
      await ingestion.idle();
      await fits.idle();
    };
    return { app, state, settle, fits };
  }

  async function signedIn(app: ReturnType<typeof buildTestApp>, email = credentials.email) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  type Agent = Awaited<ReturnType<typeof signedIn>>;

  const addResume = async (agent: Agent, content = resumeText) =>
    (await agent.post('/career/resume').attach('file', Buffer.from(content), 'cv.txt')).body
      .document.id as string;
  const addJob = async (agent: Agent, content: string) =>
    (await agent.post('/career/jobs').attach('file', Buffer.from(content), 'job.txt')).body.document
      .id as string;

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const sectionsOf = async (id: string, section: string) =>
    (await db.select().from(chunks).where(eq(chunks.documentId, id))).filter(
      (row) => row.section === section,
    );
  const overviewOf = async (agent: Agent) => (await agent.get('/career/overview')).body;

  describe('when both are there', () => {
    it('compares a posting that was added before the resume', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go', 'Kubernetes'));
      await settle();
      expect(state.matches).toEqual([]);
      expect((await documentRow(job)).fit).toBeNull();

      const resume = await addResume(agent);
      await settle();

      expect(state.matches).toHaveLength(1);
      expect((await documentRow(job)).fit).toMatchObject({ resumeId: resume, coverage: 50 });
      expect((await sectionsOf(job, 'fit')).map((r) => r.content.split('\n')[0])).toEqual([
        'Job #1 · job · Fit analysis · Strengths',
        'Job #1 · job · Fit analysis · Gaps',
      ]);
      expect((await sectionsOf(resume, 'overview')).length).toBeGreaterThan(0);
    });

    it('compares a posting that is added after the resume', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const resume = await addResume(agent);
      await settle();
      expect(state.matches).toEqual([]);

      const job = await addJob(agent, posting('Backend', 'Go'));
      await settle();

      expect(state.matches).toHaveLength(1);
      expect((await documentRow(job)).fit?.resumeId).toBe(resume);
      expect((await sectionsOf(resume, 'overview'))[0]?.content).toContain('Job #1');
    });

    it('gives the matcher the posting, the text of the resume without contacts, and the years', async () => {
      const { app, state, settle } = setup();
      state.resumeYears = 7.5;
      const agent = await signedIn(app);
      await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();

      expect(state.matches[0]).toMatchObject({ title: 'Backend', resumeYears: 7.5 });
      expect(state.matches[0]?.resumeText).toBe('Alex Morgan\n[email] | [phone]\nGo, Rust, Docker');
    });

    it('compares nothing while there is no resume', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);

      await addJob(agent, posting('Backend', 'Go'));
      await addJob(agent, posting('Data', 'Go'));
      await settle();

      expect(state.matches).toEqual([]);
      expect((await overviewOf(agent)).resume).toBeNull();
    });

    it('does not compare again what is already compared with this resume', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();

      await addJob(agent, posting('Data', 'Go'));
      await settle();

      expect(state.matches.map((m) => m.title)).toEqual(['Backend', 'Data']);
    });

    it('compares only the postings of the same user', async () => {
      const { app, state, settle } = setup();
      const ada = await signedIn(app);
      const grace = await signedIn(app, 'grace@example.com');
      const adaJob = await addJob(ada, posting('Ada role', 'Go'));
      const graceResume = await addResume(grace);
      await settle();

      expect(state.matches).toEqual([]);
      expect((await documentRow(adaJob)).fit).toBeNull();
      expect((await sectionsOf(graceResume, 'overview')).length).toBe(0);
    });
  });

  describe('the overview', () => {
    it('ranks the postings from the best covered and counts the gaps they share', async () => {
      const { app, state, settle } = setup();
      state.coverage = new Map([
        ['Low', 30],
        ['High', 90],
        ['Mid', 60],
      ]);
      const agent = await signedIn(app);
      await addJob(agent, posting('Low', 'Go', 'Kubernetes'));
      await addJob(agent, posting('High', 'Go', 'Kubernetes'));
      await addJob(agent, posting('Mid', 'Go', 'Terraform'));
      await addResume(agent);
      await settle();

      const overview = await overviewOf(agent);

      expect(overview.postings.map((p: { fit: Fit }) => p.fit.coverage)).toEqual([90, 60, 30]);
      expect(overview.compared).toBe(3);
      expect(
        overview.gaps.map((g: { label: string; postings: number }) => [g.label, g.postings]),
      ).toEqual([
        ['Kubernetes', 2],
        ['Terraform', 1],
      ]);
      expect(overview.resume).toMatchObject({ filename: 'cv', status: 'ready' });
    });

    it('writes the ranking into a passage of the resume that can be found', async () => {
      const { app, state, settle } = setup();
      state.coverage = new Map([
        ['Low', 30],
        ['High', 90],
      ]);
      const agent = await signedIn(app);
      await addJob(agent, posting('Low', 'Go'));
      await addJob(agent, posting('High', 'Go'));
      const resume = await addResume(agent);
      await settle();

      const [passage] = await sectionsOf(resume, 'overview');

      expect(passage?.content.split('\n')[0]).toBe('Resume · Overview');
      expect(passage?.content).toContain('- Rank 1: Job #2 (job): 90%');
      expect(passage?.content).toContain('- Rank 2: Job #1 (job): 30%');
    });

    it('puts a posting without a comparison last, and says so in the passage', async () => {
      const { app, state, settle } = setup();
      state.noJobProfile.add('Mystery');
      const agent = await signedIn(app);
      await addJob(agent, posting('Mystery', 'Go'));
      await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();

      const overview = await overviewOf(agent);

      expect(
        overview.postings.map((p: { jobNumber: number; fit: Fit | null }) => [
          p.jobNumber,
          p.fit !== null,
        ]),
      ).toEqual([
        [2, true],
        [1, false],
      ]);
      expect((await sectionsOf(resume, 'overview'))[0]?.content).toContain(
        'Not compared yet: Job #1 (job).',
      );
    });

    it('leaves out of the passage a posting that is still being processed', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const me = await agent.get('/auth/me');
      await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();
      await repository.createJobPosting({
        userId: me.body.user.id,
        filename: 'Pending',
        mimeType: 'text/plain',
        sizeBytes: 10,
      });
      const another = await addJob(agent, posting('Data', 'Go'));
      await settle();

      const text = (await sectionsOf(resume, 'overview'))[0]?.content;

      expect(await documentRow(another)).toMatchObject({ status: 'ready' });
      expect(text).toContain('Job #3 (job)');
      expect(text).not.toMatch(/Not compared yet/);
    });

    it('shows no comparison that was made with another resume', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();
      const me = await agent.get('/auth/me');
      const current = (await documentRow(job)).fit!;
      await repository.replaceFit({
        documentId: job,
        userId: me.body.user.id,
        fit: { ...current, resumeId: 'an-older-resume' },
        chunks: [],
      });

      const overview = await overviewOf(agent);

      expect(overview.postings[0]).toMatchObject({ id: job, fit: null });
      expect(overview.compared).toBe(0);
      expect(overview.gaps).toEqual([]);

      await addJob(agent, posting('Data', 'Go'));
      await settle();
      const text = (await sectionsOf(resume, 'overview'))[0]?.content;
      expect(text).toContain('- Rank 1: Job #2 (job)');
      expect(text).not.toContain('Rank 2');
      expect(text).toContain('Not compared yet: Job #1 (job).');
    });

    it('is shown only to its owner', async () => {
      const { app } = setup();

      const res = await request(app).get('/career/overview');

      expect(res.status).toBe(401);
    });
  });

  describe('when the resume changes', () => {
    it('forgets every comparison at once when the resume is deleted', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();
      expect((await sectionsOf(job, 'fit')).length).toBeGreaterThan(0);

      await agent.delete(`/documents/${resume}`);
      await settle();

      expect((await documentRow(job)).fit).toBeNull();
      expect(await sectionsOf(job, 'fit')).toEqual([]);
      const overview = await overviewOf(agent);
      expect(overview.resume).toBeNull();
      expect(overview.postings[0].fit).toBeNull();
      expect(overview.compared).toBe(0);
    });

    it('compares the postings with a new resume after the old one was replaced', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const first = await addResume(agent);
      await settle();
      await agent.delete(`/documents/${first}`);
      await settle();

      const second = await addResume(agent, 'Alex\nSKILLS\nPython');
      await settle();

      expect(state.matches.map((m) => m.resumeId)).toEqual([first, second]);
      expect((await documentRow(job)).fit?.resumeId).toBe(second);
      expect((await sectionsOf(second, 'overview')).length).toBeGreaterThan(0);
      expect(await sectionsOf(job, 'fit')).toHaveLength(1);
    });

    it('never shows a comparison made with another resume', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const first = await addResume(agent);
      await settle();
      await agent.delete(`/documents/${first}`);
      state.matcherFails = true;

      await addResume(agent);
      await settle();

      const overview = await overviewOf(agent);
      expect(overview.postings[0]).toMatchObject({ id: job, fit: null });
      expect(overview.compared).toBe(0);
    });

    it('compares again when the profile of the resume is rebuilt with other years', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();
      expect(state.matches).toHaveLength(1);
      state.resumeYears = 9;

      const res = await agent.post(`/career/${resume}/analysis`);
      await settle();

      expect(res.status).toBe(200);
      expect(state.matches.map((m) => m.resumeYears)).toEqual([6, 9]);
    });
  });

  describe('when a posting changes', () => {
    it('removes it from the overview when it is deleted', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const first = await addJob(agent, posting('Backend', 'Go'));
      await addJob(agent, posting('Data', 'Go'));
      const resume = await addResume(agent);
      await settle();
      expect((await sectionsOf(resume, 'overview'))[0]?.content).toContain('Job #1');

      await agent.delete(`/documents/${first}`);
      await settle();

      const text = (await sectionsOf(resume, 'overview'))[0]?.content;
      expect(text).not.toContain('Job #1');
      expect(text).toContain('Job #2');
      expect((await overviewOf(agent)).compared).toBe(1);
    });

    it('drops the overview when the last compared posting is deleted', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();

      await agent.delete(`/documents/${job}`);
      await settle();

      expect(await sectionsOf(resume, 'overview')).toEqual([]);
    });

    it('compares again, with the new requirements, when its profile is rebuilt', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();

      const res = await agent.post(`/career/${job}/analysis`);
      await settle();

      expect(res.status).toBe(200);
      expect(state.matches.map((m) => m.title)).toEqual(['Backend', 'Backend']);
      expect(await sectionsOf(job, 'fit')).toHaveLength(1);
    });
  });

  describe('when the model cannot help', () => {
    it('leaves the posting ready without a comparison, and compares it when asked', async () => {
      const { app, state, settle } = setup();
      state.matcherFails = true;
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();
      expect(await documentRow(job)).toMatchObject({ status: 'ready', fit: null });

      state.matcherFails = false;
      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(200);
      expect(res.body.document.fit).toMatchObject({ coverage: 50 });
      expect((await documentRow(job)).fit).not.toBeNull();
      expect((await overviewOf(agent)).compared).toBe(1);
    });

    it('answers 503 and keeps the earlier comparison when the matcher gives nothing', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();
      const before = (await documentRow(job)).fit;
      state.matcherFails = true;

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({
        code: 'ai_busy',
        message: 'The comparison could not be made right now. Try again in a minute.',
      });
      expect((await documentRow(job)).fit).toEqual(before);
      expect(await sectionsOf(job, 'fit')).toHaveLength(1);
    });

    it('answers 503 and keeps the earlier comparison when the new passages cannot be embedded', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();
      const before = (await documentRow(job)).fit;
      state.embeddingFails = true;

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(503);
      expect((await documentRow(job)).fit).toEqual(before);
    });

    it('builds the profile of a posting first when it has none', async () => {
      const { app, state, settle } = setup();
      state.noJobProfile.add('Backend');
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();
      expect(await documentRow(job)).toMatchObject({ profile: null, fit: null });

      state.noJobProfile.clear();
      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({
        profile: { role: 'job', requirementCount: 1 },
        fit: { coverage: 50 },
      });
    });

    it('answers 503 when the profile of the posting cannot be built either', async () => {
      const { app, state, settle } = setup();
      state.noJobProfile.add('Backend');
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(503);
    });

    it('does not break indexing when the step after it fails', async () => {
      const { app, settle } = setup({ hookThrows: true });
      const agent = await signedIn(app);

      const resume = await addResume(agent);
      await settle();

      expect(await documentRow(resume)).toMatchObject({ status: 'ready', error: null });
    });
  });

  describe('asking for a comparison', () => {
    it('compares again every time it is asked, even when the posting is already compared', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await addResume(agent);
      await settle();

      await agent.post(`/career/jobs/${job}/fit`);
      await agent.post(`/career/jobs/${job}/fit`);

      expect(state.matches).toHaveLength(3);
      expect(await sectionsOf(job, 'fit')).toHaveLength(1);
    });

    it('keeps the passages tidy when two requests arrive together', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go', 'Kubernetes'));
      await addResume(agent);
      await settle();

      const results = await Promise.all([
        agent.post(`/career/jobs/${job}/fit`),
        agent.post(`/career/jobs/${job}/fit`),
      ]);

      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(state.matches).toHaveLength(3);
      expect(await sectionsOf(job, 'fit')).toHaveLength(2);
    });

    it('does not compare again what is already compared when nobody insists', async () => {
      const { app, state, settle, fits } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();
      const me = await agent.get('/auth/me');
      const userId = me.body.user.id as string;

      expect(await fits.analyze(job, userId)).toEqual({ status: 'fresh' });
      fits.schedule(resume, userId);
      fits.schedule(job, userId);
      await settle();

      expect(state.matches).toHaveLength(1);
    });

    it('compares again when it is insisted upon', async () => {
      const { app, state, settle, fits } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      const resume = await addResume(agent);
      await settle();
      const me = await agent.get('/auth/me');
      const userId = me.body.user.id as string;

      fits.schedule(resume, userId, { force: true });
      fits.schedule(job, userId, { force: true });
      await settle();

      expect(state.matches).toHaveLength(3);
    });

    it('does not write a comparison for a resume that was deleted while it was being made', async () => {
      const { app, state, settle } = setup();
      const agent = await signedIn(app);
      const me = await agent.get('/auth/me');
      const resume = await addResume(agent);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await settle();
      state.onMatch = async () => {
        state.onMatch = undefined;
        await repository.deleteForUser(resume, me.body.user.id);
      };

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(409);
      expect((await documentRow(job)).fit?.analyzedAt).toBe('call-1');
      expect(state.matches).toHaveLength(2);
    });

    it('does not compare files that were indexed with another embedding model', async () => {
      const { app, state } = setup();
      const agent = await signedIn(app);
      const me = await agent.get('/auth/me');
      const userId = me.body.user.id as string;
      const readyWith = async (kind: 'resume' | 'job_posting', embeddingModel: string) => {
        const document =
          kind === 'resume'
            ? await repository.create({
                userId,
                kind,
                filename: 'cv',
                mimeType: 'text/plain',
                sizeBytes: 10,
              })
            : await repository.createJobPosting({
                userId,
                filename: 'job',
                mimeType: 'text/plain',
                sizeBytes: 10,
              });
        await repository.completeWithChunks({
          documentId: document.id,
          userId,
          pageCount: null,
          embeddingModel,
          profile:
            kind === 'resume'
              ? {
                  role: 'resume',
                  headline: null,
                  skills: [],
                  roles: [],
                  education: [],
                  totalExperienceYears: null,
                }
              : {
                  role: 'job',
                  title: 'Old',
                  company: null,
                  minYearsExperience: null,
                  requirements: [
                    { id: 'r1', text: 'Go', skill: 'Go', importance: 'must', quote: 'Go' },
                  ],
                  responsibilities: [],
                },
          chunks: [],
        });
        return document.id;
      };
      await readyWith('resume', 'older-model');
      const job = await readyWith('job_posting', 'fake-model');

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/different embedding model/);
      expect(state.matches).toEqual([]);
    });

    it('answers 409 when there is no resume yet', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, posting('Backend', 'Go'));
      await settle();

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe(
        'Add your resume first, then compare it with the posting',
      );
    });

    it('answers 409 while the posting is still being processed', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      await addResume(agent);
      const job = await addJob(agent, posting('Backend', 'Go'));

      const res = await agent.post(`/career/jobs/${job}/fit`);
      await settle();

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('The file is still being processed');
    });

    it('answers 409 for a posting that lists nothing to compare', async () => {
      const { app, settle } = setup();
      const agent = await signedIn(app);
      const job = await addJob(agent, 'Backend\nWe are a friendly team.');
      await addResume(agent);
      await settle();

      const res = await agent.post(`/career/jobs/${job}/fit`);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe('The posting lists no requirements to compare');
    });

    it("answers 404 for the resume, for another user's posting and for what is not an id", async () => {
      const { app, settle } = setup();
      const ada = await signedIn(app);
      const grace = await signedIn(app, 'grace@example.com');
      const resume = await addResume(ada);
      const graceJob = await addJob(grace, posting('Grace role', 'Go'));
      await settle();

      for (const id of [resume, graceJob, 'not-an-id', '00000000-0000-4000-8000-000000000099']) {
        const res = await ada.post(`/career/jobs/${id}/fit`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
      }
    });

    it('requires a signed-in user', async () => {
      const { app } = setup();

      const res = await request(app).post('/career/jobs/00000000-0000-4000-8000-000000000001/fit');

      expect(res.status).toBe(401);
    });
  });
});
