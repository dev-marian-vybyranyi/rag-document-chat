import { describe, expect, it } from 'vitest';
import { chunks, documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import type { CareerSection } from '../../src/career/types.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { useTestDb } from './helpers.js';

const embedding = (axis: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));

describe('searching resumes and job postings', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addSource(
    userId: string,
    source: { kind: 'resume' | 'job_posting' | 'document'; filename: string; jobNumber?: number },
    passages: Array<{ content: string; section?: CareerSection }>,
  ) {
    const [doc] = await db
      .insert(documents)
      .values({
        userId,
        kind: source.kind,
        filename: source.filename,
        jobNumber: source.jobNumber ?? null,
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: 'ready',
      })
      .returning();
    await db.insert(chunks).values(
      passages.map((passage, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        section: passage.section ?? null,
        content: passage.content,
        tokenCount: 5,
        embedding: embedding(ordinal),
      })),
    );
    return doc!;
  }

  const kubernetes = 'Resume · Skills\nKubernetes, Terraform and Docker in production.';
  const requirement = 'Job #2 · Platform Engineer · Requirements\nHands-on Kubernetes experience.';

  async function seed() {
    const ada = await createUser('ada@example.com');
    const resume = await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf' }, [
      { content: kubernetes, section: 'skills' },
      { content: 'Resume · Education\nBSc Computer Science.', section: 'education' },
    ]);
    const job = await addSource(
      ada.id,
      { kind: 'job_posting', filename: 'Platform Engineer', jobNumber: 2 },
      [{ content: requirement, section: 'requirements' }],
    );
    return { ada, resume, job };
  }

  it('finds the passages of a resume and of a posting by keyword', async () => {
    const { ada } = await seed();

    const found = await store.keywordSearch(ada.id, 'Kubernetes', 5);

    expect(found.map((hit) => hit.content).sort()).toEqual([kubernetes, requirement].sort());
  });

  it('says which side and which part a keyword hit comes from', async () => {
    const { ada } = await seed();

    const found = await store.keywordSearch(ada.id, 'Kubernetes', 5);

    expect(found.find((hit) => hit.content === kubernetes)?.career).toEqual({
      role: 'resume',
      section: 'skills',
      jobNumber: null,
    });
    expect(found.find((hit) => hit.content === requirement)?.career).toEqual({
      role: 'job_posting',
      section: 'requirements',
      jobNumber: 2,
    });
  });

  it('says the same about a vector hit', async () => {
    const { ada } = await seed();

    const hits = await store.vectorSearch(ada.id, embedding(0), 5);

    expect(hits.find((hit) => hit.content === requirement)?.career).toEqual({
      role: 'job_posting',
      section: 'requirements',
      jobNumber: 2,
    });
    expect(hits.find((hit) => hit.content === kubernetes)?.career).toEqual({
      role: 'resume',
      section: 'skills',
      jobNumber: null,
    });
  });

  it('keeps a passage without a section readable', async () => {
    const ada = await createUser('ada@example.com');
    await addSource(ada.id, { kind: 'resume', filename: 'cv.txt' }, [
      { content: 'Plain resume text about Rust.' },
    ]);

    const [hit] = await store.keywordSearch(ada.id, 'Rust', 5);

    expect(hit?.career).toEqual({ role: 'resume', section: null, jobNumber: null });
  });

  it('finds the generated fit and overview passages too', async () => {
    const ada = await createUser('ada@example.com');
    await addSource(ada.id, { kind: 'job_posting', filename: 'Data Engineer', jobNumber: 1 }, [
      { content: 'Job #1 · Fit\nGaps: Spark is not shown in the resume.', section: 'fit' },
    ]);
    await addSource(ada.id, { kind: 'resume', filename: 'cv.pdf' }, [
      { content: 'Overview of postings\nJob #1 fits best.', section: 'overview' },
    ]);

    const found = await store.keywordSearch(ada.id, 'Spark fits', 5);

    expect(found.map((hit) => hit.career?.section).sort()).toEqual(['fit', 'overview']);
  });

  it('gives no career location for documents, and finds them next to the career sources', async () => {
    const { ada } = await seed();
    await addSource(ada.id, { kind: 'document', filename: 'handbook.pdf' }, [
      { content: 'Our Kubernetes handbook.' },
    ]);

    const found = await store.keywordSearch(ada.id, 'Kubernetes', 5);

    expect(found).toHaveLength(3);
    expect(found.find((hit) => hit.content === 'Our Kubernetes handbook.')).not.toHaveProperty(
      'career',
    );
  });

  it('does not treat them as code or as a meeting', async () => {
    const { ada } = await seed();

    const found = await store.keywordSearch(ada.id, 'Kubernetes', 5);

    for (const hit of found) {
      expect(hit).not.toHaveProperty('code');
      expect(hit).not.toHaveProperty('meeting');
    }
  });

  it('stays within the chosen sources and the owner', async () => {
    const { ada, job } = await seed();
    const other = await createUser('grace@example.com');
    await addSource(other.id, { kind: 'resume', filename: 'cv.pdf' }, [
      { content: 'Kubernetes belongs to somebody else.' },
    ]);

    const chosen = await store.keywordSearch(ada.id, 'Kubernetes', 5, { documentIds: [job.id] });
    const all = await store.keywordSearch(ada.id, 'Kubernetes', 5);

    expect(chosen.map((hit) => hit.content)).toEqual([requirement]);
    expect(all.map((hit) => hit.content)).not.toContain('Kubernetes belongs to somebody else.');
  });
});
