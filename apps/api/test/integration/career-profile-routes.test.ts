import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { createCareerProfileService } from '../../src/career/regenerate.js';
import type { JobProfile, ResumeProfile } from '../../src/career/types.js';
import { chunks, documents, EMBEDDING_DIMENSIONS } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);

const newResume: ResumeProfile = {
  role: 'resume',
  headline: 'Backend Engineer',
  skills: [{ name: 'Go', quote: 'Go, Rust' }],
  roles: [],
  education: [],
  totalExperienceYears: null,
};

const newJob: JobProfile = {
  role: 'job',
  title: 'Platform Engineer',
  company: 'Acme',
  minYearsExperience: null,
  requirements: [
    { id: 'r1', text: 'Terraform', skill: 'Terraform', importance: 'must', quote: 'Terraform' },
  ],
  responsibilities: [],
};

describe('rebuilding the profile of a resume or a job posting', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(
    options: {
      resume?: ResumeProfile | null;
      job?: JobProfile | null;
      embedder?: Embedder;
      embeddingModel?: string;
    } = {},
  ) {
    const { resume = newResume, job = newJob, embedder = createFakeEmbedder() } = options;
    const calls = {
      resume: [] as string[],
      job: [] as Array<{ name: string; text: string }>,
    };
    const profiles = createCareerProfileService({
      repository,
      embedder,
      resumeProfiles: {
        extract: async (text) => {
          calls.resume.push(text);
          return resume;
        },
      },
      jobProfiles: {
        extract: async (input) => {
          calls.job.push(input);
          return job;
        },
      },
      embeddingModel: options.embeddingModel ?? 'fake-model',
    });
    const app = buildTestApp(db, { careerProfiles: profiles });
    return { app, calls };
  }

  async function signedIn(app: ReturnType<typeof buildTestApp>, email = credentials.email) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ ...credentials, email });
    return { agent, userId: res.body.user.id as string };
  }

  async function addReady(
    userId: string,
    kind: 'resume' | 'job_posting',
    options: { embeddingModel?: string; filename?: string; jobNumber?: number } = {},
  ) {
    const document = await repository.create({
      userId,
      kind,
      filename: options.filename ?? (kind === 'resume' ? 'cv' : 'Platform role'),
      mimeType: 'text/plain',
      sizeBytes: 100,
      ...(kind === 'job_posting' && { jobNumber: options.jobNumber ?? 1 }),
    });
    const row = (
      ordinal: number,
      section: 'skills' | 'experience' | 'profile' | null,
      content: string,
    ) => ({
      ordinal,
      page: null,
      section,
      content,
      tokenCount: 5,
      embedding: vector,
    });
    await repository.completeWithChunks({
      documentId: document.id,
      userId,
      pageCount: null,
      embeddingModel: options.embeddingModel ?? 'fake-model',
      profile: { ...newResume, headline: 'Old headline' },
      chunks: [
        row(0, 'skills', 'Resume · Skills\nGo, Rust'),
        row(
          1,
          'experience',
          'Resume · Experience · Engineer, Acme\nEngineer, Acme (2020 – 2023)\n- Built APIs',
        ),
        row(2, 'profile', 'Resume · Profile\nSkills: Old'),
        row(3, null, 'Resume\n- Mentored two juniors'),
      ],
    });
    return document.id;
  }

  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);
  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;

  it('requires a signed-in user', async () => {
    const { app } = setup();

    const res = await request(app).post('/career/00000000-0000-4000-8000-000000000001/analysis');

    expect(res.status).toBe(401);
  });

  describe('a resume', () => {
    it('replaces the profile and its passage, and keeps the text as it was', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      const res = await agent.post(`/career/${id}/analysis`);

      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({
        id,
        profile: { role: 'resume', skills: ['Go'], totalExperienceYears: null },
      });
      expect((await documentRow(id)).profile).toEqual(newResume);
      const rows = await chunkRows(id);
      expect(rows.map((r) => [r.ordinal, r.section])).toEqual([
        [0, 'skills'],
        [1, 'experience'],
        [3, null],
        [4, 'profile'],
      ]);
      expect(rows[3]?.content).toBe(
        ['Resume · Profile', 'Headline: Backend Engineer', 'Skills: Go'].join('\n'),
      );
    });

    it('builds the profile from the stored text, without the context lines and the old profile', async () => {
      const { app, calls } = setup();
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      await agent.post(`/career/${id}/analysis`);

      expect(calls.resume).toEqual([
        'Go, Rust\nEngineer, Acme (2020 – 2023)\n- Built APIs\n- Mentored two juniors',
      ]);
    });

    it('embeds the new passage exactly as it is stored', async () => {
      const embedder = createFakeEmbedder();
      const { app } = setup({ embedder });
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      await agent.post(`/career/${id}/analysis`);

      expect(embedder.documentCalls).toEqual([[(await chunkRows(id)).at(-1)!.content]]);
    });

    it('can be repeated: the profile passage never piles up', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      await agent.post(`/career/${id}/analysis`);
      await agent.post(`/career/${id}/analysis`);

      expect((await chunkRows(id)).filter((r) => r.section === 'profile')).toHaveLength(1);
    });
  });

  describe('a job posting', () => {
    it('is given to the model with its name, and gets the new profile', async () => {
      const { app, calls } = setup();
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'job_posting', { filename: 'Platform role at Acme' });

      const res = await agent.post(`/career/${id}/analysis`);

      expect(res.status).toBe(200);
      expect(res.body.document.profile).toEqual({
        role: 'job',
        title: 'Platform Engineer',
        company: 'Acme',
        requirementCount: 1,
      });
      expect(calls.job).toEqual([
        {
          name: 'Platform role at Acme',
          text: 'Go, Rust\nEngineer, Acme (2020 – 2023)\n- Built APIs\n- Mentored two juniors',
        },
      ]);
      expect((await chunkRows(id)).at(-1)?.content).toBe(
        [
          'Job #1 · Platform role at Acme · Profile',
          'Role: Platform Engineer at Acme',
          'Must have:',
          '- Terraform',
        ].join('\n'),
      );
    });
  });

  describe('when it cannot be done', () => {
    it('answers 503 and leaves the old profile alone when the model gives nothing', async () => {
      const { app } = setup({ resume: null });
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      const res = await agent.post(`/career/${id}/analysis`);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('ai_busy');
      expect((await documentRow(id)).profile).toMatchObject({ headline: 'Old headline' });
      expect((await chunkRows(id)).find((r) => r.section === 'profile')?.content).toBe(
        'Resume · Profile\nSkills: Old',
      );
    });

    it('answers 503 and leaves the old profile alone when the passage cannot be embedded', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new EmbeddingError('rate_limited');
        },
        embedQuery: async () => [],
      };
      const { app } = setup({ embedder });
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      const res = await agent.post(`/career/${id}/analysis`);

      expect(res.status).toBe(503);
      expect((await documentRow(id)).profile).toMatchObject({ headline: 'Old headline' });
      expect(await chunkRows(id)).toHaveLength(4);
    });

    it('does not hide an unexpected failure', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new Error('connect ECONNRESET');
        },
        embedQuery: async () => [],
      };
      const { app } = setup({ embedder });
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume');

      const res = await agent.post(`/career/${id}/analysis`);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('internal_error');
    });

    it('answers 409 while the file is still being processed', async () => {
      const { app, calls } = setup();
      const { agent, userId } = await signedIn(app);
      const processing = await repository.create({
        userId,
        kind: 'resume',
        filename: 'cv',
        mimeType: 'text/plain',
        sizeBytes: 10,
      });

      const res = await agent.post(`/career/${processing.id}/analysis`);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'conflict',
        message: 'The file is still being processed',
      });
      expect(calls.resume).toEqual([]);
    });

    it('answers 409 for a file indexed with another embedding model', async () => {
      const { app, calls } = setup();
      const { agent, userId } = await signedIn(app);
      const id = await addReady(userId, 'resume', { embeddingModel: 'older-model' });

      const res = await agent.post(`/career/${id}/analysis`);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/different embedding model/);
      expect(calls.resume).toEqual([]);
    });

    it('answers 404 for a file that is not there, not yours, not a resume or a posting, or not an id', async () => {
      const { app, calls } = setup();
      const ada = await signedIn(app);
      const grace = await signedIn(app, 'grace@example.com');
      const theirs = await addReady(grace.userId, 'resume');
      const plain = await repository.create({
        userId: ada.userId,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
      });
      await repository.completeWithChunks({
        documentId: plain.id,
        userId: ada.userId,
        pageCount: null,
        embeddingModel: 'fake-model',
        chunks: [],
      });

      for (const id of ['00000000-0000-4000-8000-000000000099', theirs, plain.id, 'not-an-id']) {
        const res = await ada.agent.post(`/career/${id}/analysis`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
      }
      expect(calls.resume).toEqual([]);
      expect((await documentRow(theirs)).profile).toMatchObject({ headline: 'Old headline' });
    });
  });

  it('is limited like uploads are', async () => {
    const limited = buildTestApp(db, {
      uploadRateLimit: { perHour: 1 },
      careerProfiles: { regenerate: async () => ({ status: 'unavailable' }) },
    });
    const { agent } = await signedIn(limited);
    const id = '00000000-0000-4000-8000-000000000001';

    const first = await agent.post(`/career/${id}/analysis`);
    const second = await agent.post(`/career/${id}/analysis`);

    expect(first.status).toBe(503);
    expect(second.status).toBe(429);
  });
});
