import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import { createRetrievalStore, type RetrievalStore } from '../../src/rag/retrieval.js';
import { BALANCE_PASSAGES, createRetriever } from '../../src/rag/retriever.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

const QUESTION = 'Kubernetes Terraform pipeline experience';

interface Passage {
  content: string;
  embeddingOf?: string;
}

const questionEmbedder: Embedder = {
  ...createFakeEmbedder(),
  embedQuery: () => Promise.resolve(fakeVector(QUESTION)),
};

describe('keeping both sides of a comparison in the context', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  function retrieverWith(options: { embedder?: Embedder; store?: RetrievalStore } = {}) {
    return createRetriever({
      store: options.store ?? store,
      embedder: options.embedder ?? questionEmbedder,
      logger: pino({ level: 'silent' }),
    });
  }

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addSource(
    userId: string,
    source: {
      kind: 'resume' | 'job_posting' | 'document';
      filename: string;
      jobNumber?: number;
      status?: 'ready' | 'processing';
      company?: string;
    },
    passages: Passage[],
  ) {
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        kind: source.kind,
        filename: source.filename,
        jobNumber: source.jobNumber ?? null,
        profile: source.company
          ? {
              role: 'job',
              title: null,
              company: source.company,
              minYearsExperience: null,
              requirements: [],
              responsibilities: [],
            }
          : null,
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: source.status ?? 'ready',
      })
      .returning();
    await db.insert(chunks).values(
      passages.map((passage, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        content: passage.content,
        tokenCount: 5,
        embedding: fakeVector(passage.embeddingOf ?? passage.content),
      })),
    );
    return doc!;
  }

  const strong = (label: string): Passage => ({
    content: `${QUESTION} ${label}`,
    embeddingOf: QUESTION,
  });
  const weak = (label: string): Passage => ({ content: `Hobbies and travel ${label}.` });
  const strongMany = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => strong(`${prefix}${i}`));

  const roleOf = (chunk: { career?: { role: string } }) => chunk.career?.role ?? 'other';
  const texts = (result: { chunks: Array<{ content: string }> }) =>
    result.chunks.map((chunk) => chunk.content);

  const termsOf = (side: string): Passage[] => [
    { content: `Terraform pipeline modules in ${side} one.` },
    { content: `Kubernetes cluster operations in ${side} two.` },
    weak(`${side} three`),
  ];
  const sideResume = termsOf('resume');
  const sideJobs = termsOf('posting');

  async function seed(options: { jobs?: Passage[]; resume?: Passage[] } = {}) {
    const ada = await createUser('ada@example.com');
    const resume = await addSource(
      ada.id,
      { kind: 'resume', filename: 'cv.pdf' },
      options.resume ?? sideResume,
    );
    const one = await addSource(
      ada.id,
      { kind: 'job_posting', filename: 'Data Engineer', jobNumber: 1 },
      options.jobs ?? strongMany('one-', 14),
    );
    const two = await addSource(
      ada.id,
      { kind: 'job_posting', filename: 'Platform Engineer', jobNumber: 2, company: 'Acme' },
      termsOf('job two'),
    );
    return { ada, resume, one, two };
  }

  describe('when the best passages all come from the postings', () => {
    it('adds the two best passages of the resume', async () => {
      const { ada } = await seed();

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks.slice(0, 6).every((chunk) => roleOf(chunk) === 'job_posting')).toBe(
        true,
      );
      expect(result.chunks).toHaveLength(6 + BALANCE_PASSAGES);
      expect(texts(result).slice(6).sort()).toEqual(
        [
          'Kubernetes cluster operations in resume two.',
          'Terraform pipeline modules in resume one.',
        ].sort(),
      );
      expect(result.chunks.slice(6).every((chunk) => roleOf(chunk) === 'resume')).toBe(true);
    });

    it('keeps the passages it found on its own, in their order', async () => {
      const { ada } = await seed();
      const balanced = await retrieverWith().retrieve(ada.id, QUESTION);
      const plain = await retrieverWith().retrieve(ada.id, QUESTION, { balanceSides: false });

      expect(texts(balanced).slice(0, 6)).toEqual(texts(plain));
    });

    it('does not add anything when asked not to', async () => {
      const { ada } = await seed();

      const result = await retrieverWith().retrieve(ada.id, QUESTION, { balanceSides: false });

      expect(result.chunks).toHaveLength(6);
      expect(result.chunks.some((chunk) => roleOf(chunk) === 'resume')).toBe(false);
    });

    it('works on keywords alone when the question cannot be embedded', async () => {
      const { ada } = await seed();
      const failing: Embedder = {
        ...createFakeEmbedder(),
        embedQuery: () => Promise.reject(new EmbeddingError('quota_exhausted')),
      };

      const result = await retrieverWith({ embedder: failing }).retrieve(ada.id, QUESTION);

      expect(result.mode).toBe('keyword-only');
      expect(result.chunks.filter((chunk) => roleOf(chunk) === 'resume').length).toBe(2);
    });
  });

  describe('when the best passages all come from the resume', () => {
    const resumeHeavy = strongMany('cv-', 14);

    it('adds the two best passages of the postings', async () => {
      const { ada } = await seed({ resume: resumeHeavy, jobs: sideJobs });

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks.slice(0, 6).every((chunk) => roleOf(chunk) === 'resume')).toBe(true);
      const added = result.chunks.slice(6);
      expect(added).toHaveLength(BALANCE_PASSAGES);
      expect(added.every((chunk) => roleOf(chunk) === 'job_posting')).toBe(true);
    });

    it('adds them from the posting the question names, and from no other', async () => {
      const { ada, two } = await seed({
        resume: resumeHeavy,
        jobs: [
          { content: `${QUESTION} elsewhere, first.` },
          { content: `${QUESTION} elsewhere, second.` },
        ],
      });

      const result = await retrieverWith().retrieve(ada.id, `${QUESTION} at Acme`);

      const added = result.chunks.filter((chunk) => roleOf(chunk) === 'job_posting');
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((chunk) => chunk.documentId === two.id)).toBe(true);
      expect(result.filters?.jobs).toEqual(['Job #2 · Platform Engineer']);
    });

    it('adds them from the postings in the picker only', async () => {
      const { ada, resume, one } = await seed({ resume: resumeHeavy, jobs: sideJobs });

      const result = await retrieverWith().retrieve(ada.id, QUESTION, {
        documentIds: [resume.id, one.id],
      });

      const added = result.chunks.filter((chunk) => roleOf(chunk) === 'job_posting');
      expect(added.every((chunk) => chunk.documentId === one.id)).toBe(true);
      expect(added.length).toBe(BALANCE_PASSAGES);
    });
  });

  describe('when it has nothing to add', () => {
    it('leaves a result that already has both sides alone', async () => {
      const { ada } = await seed({ resume: strongMany('cv-', 3), jobs: strongMany('one-', 3) });
      const spy: RetrievalStore = {
        ...store,
        keywordSearch: (...args) => store.keywordSearch(...args),
      };
      let searches = 0;
      spy.vectorSearch = (...args) => {
        searches += 1;
        return store.vectorSearch(...args);
      };

      const result = await retrieverWith({ store: spy }).retrieve(ada.id, QUESTION);

      expect(new Set(result.chunks.map(roleOf))).toEqual(new Set(['resume', 'job_posting']));
      expect(result.chunks.length).toBeLessThanOrEqual(6);
      expect(searches).toBe(1);
    });

    it('leaves a question about other documents alone', async () => {
      const { ada } = await seed({ jobs: sideJobs });
      await addSource(ada.id, { kind: 'document', filename: 'kube.pdf' }, strongMany('doc-', 8));

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks).toHaveLength(6);
      expect(result.chunks.every((chunk) => roleOf(chunk) === 'other')).toBe(true);
    });

    it('does not count a document as either side', async () => {
      const { ada } = await seed({ resume: sideResume, jobs: strongMany('one-', 3) });
      await addSource(ada.id, { kind: 'document', filename: 'kube.pdf' }, strongMany('doc-', 3));

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks.filter((chunk) => roleOf(chunk) === 'resume')).toHaveLength(2);
      expect(result.chunks.filter((chunk) => roleOf(chunk) === 'other').length).toBeGreaterThan(0);
    });

    it('does not even search again when there are no postings', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf' }, strongMany('cv-', 14));
      let vectorSearches = 0;
      const counting: RetrievalStore = {
        ...store,
        vectorSearch: (...args) => {
          vectorSearches += 1;
          return store.vectorSearch(...args);
        },
      };

      await retrieverWith({ store: counting }).retrieve(ada.id, QUESTION);

      expect(vectorSearches).toBe(1);
    });

    it('adds nothing when the user has no resume', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(
        ada.id,
        { kind: 'job_posting', filename: 'Data Engineer', jobNumber: 1 },
        strongMany('one-', 14),
      );

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks).toHaveLength(6);
    });

    it('adds nothing when the resume is still being processed', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf', status: 'processing' }, [
        weak('cv'),
      ]);
      await addSource(
        ada.id,
        { kind: 'job_posting', filename: 'Data Engineer', jobNumber: 1 },
        strongMany('one-', 14),
      );

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks.some((chunk) => roleOf(chunk) === 'resume')).toBe(false);
    });

    it('adds nothing when there are no postings', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf' }, strongMany('cv-', 14));

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(result.chunks).toHaveLength(6);
    });

    it('adds nothing from a resume the picker left out', async () => {
      const { ada, one } = await seed();

      const result = await retrieverWith().retrieve(ada.id, QUESTION, { documentIds: [one.id] });

      expect(result.chunks.every((chunk) => roleOf(chunk) === 'job_posting')).toBe(true);
    });

    it('never borrows from another user', async () => {
      const { ada } = await seed({ resume: [weak('only')] });
      const grace = await createUser('grace@example.com');
      await addSource(grace.id, { kind: 'resume', filename: 'cv.pdf' }, [
        { content: `${QUESTION} secret resume`, embeddingOf: QUESTION },
      ]);
      const gracesJobs = await createUser('hopper@example.com');
      await addSource(gracesJobs.id, { kind: 'job_posting', filename: 'X', jobNumber: 1 }, [
        strong('foreign'),
      ]);

      const result = await retrieverWith().retrieve(ada.id, QUESTION);

      expect(
        texts(result).some((text) => text.includes('secret') || text.includes('foreign')),
      ).toBe(false);
    });
  });

  describe('together with what the question names', () => {
    it('still adds the other side when the posting limit had to be given up', async () => {
      const { ada } = await seed();
      const emptyWhenFiltered: RetrievalStore = {
        ...store,
        vectorSearch: (userId, embedding, limit, scope) =>
          scope?.jobs ? Promise.resolve([]) : store.vectorSearch(userId, embedding, limit, scope),
        keywordSearch: (userId, text, limit, scope) =>
          scope?.jobs ? Promise.resolve([]) : store.keywordSearch(userId, text, limit, scope),
      };

      const result = await retrieverWith({ store: emptyWhenFiltered }).retrieve(
        ada.id,
        `${QUESTION} Job #2`,
      );

      expect(result.filters?.relaxed).toBe(true);
      expect(result.chunks.filter((chunk) => roleOf(chunk) === 'resume')).toHaveLength(2);
    });
  });
});

describe('resumeId', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  const addResume = async (
    userId: string,
    overrides: Partial<typeof documents.$inferInsert> = {},
  ) => {
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        kind: 'resume',
        filename: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1,
        status: 'ready',
        ...overrides,
      })
      .returning();
    return doc!;
  };

  it('gives the ready resume of the user', async () => {
    const ada = await createUser('ada@example.com');
    const resume = await addResume(ada.id);

    expect(await store.resumeId(ada.id)).toBe(resume.id);
  });

  it('gives nothing without a resume, for a document, for a resume that is not ready, or for someone else', async () => {
    const ada = await createUser('ada@example.com');
    const grace = await createUser('grace@example.com');
    expect(await store.resumeId(ada.id)).toBeNull();
    await addResume(ada.id, { kind: 'document' });
    await addResume(grace.id);

    expect(await store.resumeId(ada.id)).toBeNull();
    await db.update(documents).set({ status: 'processing' }).where(undefined);
    expect(await store.resumeId(grace.id)).toBeNull();
  });

  it('stays within the chosen sources and the embedding model', async () => {
    const ada = await createUser('ada@example.com');
    const resume = await addResume(ada.id, { embeddingModel: 'model-a' });
    const sameModel = createRetrievalStore(db, { embeddingModel: 'model-a' });
    const otherModel = createRetrievalStore(db, { embeddingModel: 'model-b' });

    expect(await sameModel.resumeId(ada.id, { documentIds: [resume.id] })).toBe(resume.id);
    expect(await sameModel.resumeId(ada.id, { documentIds: [] })).toBeNull();
    expect(
      await sameModel.resumeId(ada.id, { documentIds: ['3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10'] }),
    ).toBeNull();
    expect(await otherModel.resumeId(ada.id)).toBeNull();
  });
});
