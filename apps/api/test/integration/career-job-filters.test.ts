import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { JobProfile } from '../../src/career/types.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import { createRetrievalStore, type RetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

const jobProfile = (title: string | null, company: string | null): JobProfile => ({
  role: 'job',
  title,
  company,
  minYearsExperience: null,
  requirements: [],
  responsibilities: [],
});

describe('selecting job postings by what the question names', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);
  const retriever = (retrievalStore: RetrievalStore = store) =>
    createRetriever({
      store: retrievalStore,
      embedder: createFakeEmbedder(),
      logger: pino({ level: 'silent' }),
    });

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addSource(
    userId: string,
    source: {
      kind: 'resume' | 'job_posting' | 'document' | 'transcript';
      filename: string;
      jobNumber?: number;
      profile?: JobProfile;
      status?: 'ready' | 'processing';
      model?: string;
    },
    contents: string[],
  ) {
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        kind: source.kind,
        filename: source.filename,
        jobNumber: source.jobNumber ?? null,
        profile: source.profile ?? null,
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: source.status ?? 'ready',
        embeddingModel: source.model ?? null,
      })
      .returning();
    await db.insert(chunks).values(
      contents.map((content, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        content,
        speakers: source.kind === 'transcript' ? ['Carol'] : null,
        startMs: source.kind === 'transcript' ? 0 : null,
        endMs: source.kind === 'transcript' ? 1000 : null,
        tokenCount: 5,
        embedding: fakeVector(content),
      })),
    );
    return doc!;
  }

  const resumeText = 'Resume: five years of Kubernetes in production.';
  const dataText = 'Job one wants Kubernetes and Spark for data pipelines.';
  const platformText = 'Job two wants Kubernetes and Terraform for the platform.';
  const designText = 'Job three wants Kubernetes dashboards designed beautifully.';
  const handbookText = 'Handbook: Kubernetes is explained in chapter four.';

  async function seed() {
    const ada = await createUser('ada@example.com');
    const resume = await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf' }, [resumeText]);
    const one = await addSource(
      ada.id,
      {
        kind: 'job_posting',
        filename: 'Data Engineer',
        jobNumber: 1,
        profile: jobProfile('Senior Data Engineer', 'Globex'),
      },
      [dataText],
    );
    const two = await addSource(
      ada.id,
      {
        kind: 'job_posting',
        filename: 'Platform Engineer',
        jobNumber: 2,
        profile: jobProfile('Platform Engineer', 'Acme'),
      },
      [platformText],
    );
    const three = await addSource(
      ada.id,
      { kind: 'job_posting', filename: 'Designer', jobNumber: 3 },
      [designText],
    );
    const handbook = await addSource(ada.id, { kind: 'document', filename: 'handbook.pdf' }, [
      handbookText,
    ]);
    return { ada, resume, one, two, three, handbook };
  }

  const contents = (result: { chunks: Array<{ content: string }> }) =>
    result.chunks.map((c) => c.content).sort();

  describe('what the store knows about the postings', () => {
    it('lists the ready postings with their number, name, title and company', async () => {
      const { ada, one, two, three } = await seed();

      expect(await store.jobFacts(ada.id)).toEqual([
        {
          id: one.id,
          jobNumber: 1,
          name: 'Data Engineer',
          title: 'Senior Data Engineer',
          company: 'Globex',
        },
        {
          id: two.id,
          jobNumber: 2,
          name: 'Platform Engineer',
          title: 'Platform Engineer',
          company: 'Acme',
        },
        { id: three.id, jobNumber: 3, name: 'Designer', title: null, company: null },
      ]);
    });

    it('leaves out postings that are not ready, have no number, belong to someone else or use another model', async () => {
      const ada = await createUser('ada@example.com');
      const grace = await createUser('grace@example.com');
      const ready = await addSource(
        ada.id,
        { kind: 'job_posting', filename: 'Ready', jobNumber: 1, model: 'model-a' },
        ['x'],
      );
      await addSource(
        ada.id,
        { kind: 'job_posting', filename: 'Busy', jobNumber: 2, status: 'processing' },
        ['x'],
      );
      await addSource(ada.id, { kind: 'job_posting', filename: 'Unnumbered' }, ['x']);
      await addSource(
        ada.id,
        { kind: 'job_posting', filename: 'Old', jobNumber: 3, model: 'model-b' },
        ['x'],
      );
      await addSource(grace.id, { kind: 'job_posting', filename: 'Hers', jobNumber: 1 }, ['x']);
      await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf' }, ['x']);
      const sameModel = createRetrievalStore(db, { embeddingModel: 'model-a' });

      expect((await sameModel.jobFacts(ada.id)).map((f) => f.id)).toEqual([ready.id]);
      expect((await store.jobFacts(ada.id)).map((f) => f.name)).toEqual(['Ready', 'Old']);
    });

    it('stays within the chosen sources', async () => {
      const { ada, two, resume } = await seed();

      expect((await store.jobFacts(ada.id, { documentIds: [two.id, resume.id] })).length).toBe(1);
      expect(await store.jobFacts(ada.id, { documentIds: [] })).toEqual([]);
    });

    it('leaves out sources that are not job postings, whatever number they carry', async () => {
      const ada = await createUser('ada@example.com');
      const posting = await addSource(
        ada.id,
        { kind: 'job_posting', filename: 'Real', jobNumber: 1 },
        ['x'],
      );
      await addSource(ada.id, { kind: 'document', filename: 'handbook.pdf', jobNumber: 2 }, ['x']);

      expect((await store.jobFacts(ada.id)).map((f) => f.id)).toEqual([posting.id]);
    });

    it('does not take the profile of a resume for a job profile', async () => {
      const ada = await createUser('ada@example.com');
      const [doc] = await db
        .insert(documents)
        .values({
          userId: ada.id,
          kind: 'job_posting',
          filename: 'Odd',
          jobNumber: 1,
          profile: {
            role: 'resume',
            headline: 'Engineer',
            skills: [],
            roles: [],
            education: [],
            totalExperienceYears: null,
          },
          mimeType: 'text/plain',
          sizeBytes: 1,
          status: 'ready',
        })
        .returning();

      expect(await store.jobFacts(ada.id)).toEqual([
        { id: doc!.id, jobNumber: 1, name: 'Odd', title: null, company: null },
      ]);
    });
  });

  describe('searching', () => {
    it('keeps the named posting and the resume, and drops the other postings', async () => {
      const { ada } = await seed();

      const result = await retriever().retrieve(ada.id, 'How does Kubernetes fit Job #2?');

      expect(contents(result)).toEqual([handbookText, platformText, resumeText].sort());
      expect(result.filters).toEqual({
        speakers: [],
        time: null,
        jobs: ['Job #2 · Platform Engineer'],
        relaxed: false,
      });
    });

    it('selects the posting named by its company', async () => {
      const { ada } = await seed();

      const result = await retriever().retrieve(ada.id, 'Kubernetes at Globex?');

      expect(contents(result)).toEqual([dataText, handbookText, resumeText].sort());
      expect(result.filters?.jobs).toEqual(['Job #1 · Data Engineer']);
    });

    it('selects the posting named by an ordinal word', async () => {
      const { ada } = await seed();

      const result = await retriever().retrieve(ada.id, 'Kubernetes in the third job?');

      expect(contents(result)).toEqual([designText, handbookText, resumeText].sort());
    });

    it('selects several postings', async () => {
      const { ada } = await seed();

      const result = await retriever().retrieve(ada.id, 'Kubernetes: compare jobs 1 and 3');

      expect(contents(result)).toEqual([dataText, designText, handbookText, resumeText].sort());
      expect(result.filters?.jobs).toEqual(['Job #1 · Data Engineer', 'Job #3 · Designer']);
    });

    it('searches every posting when the question names none', async () => {
      const { ada } = await seed();

      const result = await retriever().retrieve(ada.id, 'Which Kubernetes jobs fit me?');

      expect(contents(result)).toEqual(
        [dataText, platformText, designText, resumeText, handbookText].sort(),
      );
      expect(result.filters).toBeUndefined();
    });

    it('searches every posting when the number named does not exist', async () => {
      const { ada } = await seed();

      const result = await retriever().retrieve(ada.id, 'Kubernetes for Job #9?');

      expect(contents(result)).toHaveLength(5);
      expect(result.filters).toBeUndefined();
    });

    it('does not let one user name the postings of another', async () => {
      const { ada } = await seed();
      const grace = await createUser('grace@example.com');
      await addSource(grace.id, { kind: 'job_posting', filename: 'Hers', jobNumber: 2 }, [
        'Grace job: Kubernetes secrets.',
      ]);

      const result = await retriever().retrieve(ada.id, 'Kubernetes in Job #2?');

      expect(contents(result)).not.toContain('Grace job: Kubernetes secrets.');
      expect(contents(result)).toContain(platformText);
    });

    it('stays within the sources chosen in the picker', async () => {
      const { ada, two, resume } = await seed();

      const result = await retriever().retrieve(ada.id, 'Kubernetes in Job #2?', {
        documentIds: [two.id, resume.id],
      });

      expect(contents(result)).toEqual([platformText, resumeText].sort());
    });

    it('cannot select a posting the picker left out', async () => {
      const { ada, two, resume } = await seed();

      const result = await retriever().retrieve(ada.id, 'Kubernetes in Job #1?', {
        documentIds: [two.id, resume.id],
      });

      expect(contents(result)).toEqual([platformText, resumeText].sort());
      expect(result.filters).toBeUndefined();
    });

    it('applies together with a speaker named in the question', async () => {
      const { ada } = await seed();
      await addSource(ada.id, { kind: 'transcript', filename: 'Sync' }, [
        'Carol said Kubernetes is fine.',
      ]);
      await db.update(documents).set({ participants: ['Carol'], durationMs: 1000 });

      const result = await retriever().retrieve(
        ada.id,
        'What did Carol say about Kubernetes in Job #2?',
      );

      expect(result.filters).toMatchObject({
        speakers: ['Carol'],
        jobs: ['Job #2 · Platform Engineer'],
        relaxed: false,
      });
      expect(contents(result)).toContain('Carol said Kubernetes is fine.');
      expect(contents(result)).not.toContain(dataText);
    });

    it('goes back to every posting, and says so, when the named ones gave nothing', async () => {
      const { ada } = await seed();
      const emptyWhenFiltered: RetrievalStore = {
        ...store,
        vectorSearch: (userId, embedding, limit, scope) =>
          scope?.jobs ? Promise.resolve([]) : store.vectorSearch(userId, embedding, limit, scope),
        keywordSearch: (userId, text, limit, scope) =>
          scope?.jobs ? Promise.resolve([]) : store.keywordSearch(userId, text, limit, scope),
      };

      const result = await retriever(emptyWhenFiltered).retrieve(ada.id, 'Kubernetes in Job #2?');

      expect(contents(result)).toHaveLength(5);
      expect(result.filters).toEqual({
        speakers: [],
        time: null,
        jobs: ['Job #2 · Platform Engineer'],
        relaxed: true,
      });
    });
  });
});
