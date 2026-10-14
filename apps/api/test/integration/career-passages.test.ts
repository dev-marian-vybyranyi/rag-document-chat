import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Fit } from '../../src/career/types.js';
import { chunks, documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import { createDocumentRepository, type NewChunk } from '../../src/documents/repository.js';
import { useTestDb } from './helpers.js';

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);

const passage = (content: string): Omit<NewChunk, 'ordinal'> => ({
  page: null,
  content,
  tokenCount: 5,
  embedding: vector,
});

const fit = (coverage: number): Fit => ({
  resumeId: 'resume-1',
  analyzedAt: '2026-10-13T10:00:00.000Z',
  requirements: [],
  coverage,
  mustCoverage: null,
});

describe('replacing the passages that are made from other passages', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  async function readyDocument(kind: 'resume' | 'job_posting') {
    const [user] = await db
      .insert(users)
      .values({ email: `${kind}@example.com`, passwordHash: 'hash' })
      .returning();
    const document = await repository.create({
      userId: user!.id,
      kind,
      filename: 'source',
      mimeType: 'text/plain',
      sizeBytes: 10,
      ...(kind === 'job_posting' && { jobNumber: 1 }),
    });
    await repository.completeWithChunks({
      documentId: document.id,
      userId: user!.id,
      pageCount: null,
      chunks: [
        { ...passage('first'), ordinal: 0, section: 'requirements' },
        { ...passage('second'), ordinal: 1, section: 'requirements' },
        { ...passage('profile'), ordinal: 2, section: 'profile' },
      ],
    });
    return { id: document.id, userId: user!.id };
  }

  const rows = async (id: string) =>
    (await db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal)).map(
      (r) => [r.ordinal, r.section, r.content] as const,
    );

  describe('the fit of a job posting', () => {
    it('adds passages after the others, stores the fit and leaves the rest alone', async () => {
      const { id, userId } = await readyDocument('job_posting');

      await repository.replaceFit({
        documentId: id,
        userId,
        fit: fit(70),
        chunks: [passage('strengths'), passage('gaps')],
      });

      expect(await rows(id)).toEqual([
        [0, 'requirements', 'first'],
        [1, 'requirements', 'second'],
        [2, 'profile', 'profile'],
        [3, 'fit', 'strengths'],
        [4, 'fit', 'gaps'],
      ]);
      expect((await db.select().from(documents).where(eq(documents.id, id)))[0]?.fit).toEqual(
        fit(70),
      );
    });

    it('replaces the earlier passages, so that they never pile up', async () => {
      const { id, userId } = await readyDocument('job_posting');
      await repository.replaceFit({
        documentId: id,
        userId,
        fit: fit(70),
        chunks: [passage('old')],
      });

      await repository.replaceFit({
        documentId: id,
        userId,
        fit: fit(80),
        chunks: [passage('new strengths'), passage('new gaps')],
      });

      expect((await rows(id)).filter(([, section]) => section === 'fit')).toEqual([
        [3, 'fit', 'new strengths'],
        [4, 'fit', 'new gaps'],
      ]);
      expect((await db.select().from(documents).where(eq(documents.id, id)))[0]?.fit).toEqual(
        fit(80),
      );
    });

    it('clears the fit and its passages when it is given none', async () => {
      const { id, userId } = await readyDocument('job_posting');
      await repository.replaceFit({
        documentId: id,
        userId,
        fit: fit(70),
        chunks: [passage('old')],
      });

      await repository.replaceFit({ documentId: id, userId, fit: null, chunks: [] });

      expect((await rows(id)).map(([, section]) => section)).toEqual([
        'requirements',
        'requirements',
        'profile',
      ]);
      expect((await db.select().from(documents).where(eq(documents.id, id)))[0]?.fit).toBeNull();
    });

    it('does not touch another document', async () => {
      const first = await readyDocument('job_posting');
      const [otherUser] = await db
        .insert(users)
        .values({ email: 'other@example.com', passwordHash: 'hash' })
        .returning();
      const other = await repository.create({
        userId: otherUser!.id,
        kind: 'job_posting',
        filename: 'other',
        mimeType: 'text/plain',
        sizeBytes: 10,
        jobNumber: 1,
      });
      await repository.completeWithChunks({
        documentId: other.id,
        userId: otherUser!.id,
        pageCount: null,
        chunks: [{ ...passage('mine'), ordinal: 0, section: 'fit' }],
      });

      await repository.replaceFit({
        documentId: first.id,
        userId: first.userId,
        fit: null,
        chunks: [],
      });

      expect(await rows(other.id)).toEqual([[0, 'fit', 'mine']]);
    });
  });

  describe('the overview of a resume', () => {
    it('adds passages after the others and replaces its own earlier ones only', async () => {
      const { id, userId } = await readyDocument('resume');
      await repository.replaceOverview({
        documentId: id,
        userId,
        chunks: [passage('old overview')],
      });

      await repository.replaceOverview({
        documentId: id,
        userId,
        chunks: [passage('overview one'), passage('overview two')],
      });

      expect(await rows(id)).toEqual([
        [0, 'requirements', 'first'],
        [1, 'requirements', 'second'],
        [2, 'profile', 'profile'],
        [3, 'overview', 'overview one'],
        [4, 'overview', 'overview two'],
      ]);
    });

    it('removes the overview when it is given nothing', async () => {
      const { id, userId } = await readyDocument('resume');
      await repository.replaceOverview({ documentId: id, userId, chunks: [passage('old')] });

      await repository.replaceOverview({ documentId: id, userId, chunks: [] });

      expect((await rows(id)).some(([, section]) => section === 'overview')).toBe(false);
    });

    it('keeps the fit passages of the same document apart from the overview', async () => {
      const { id, userId } = await readyDocument('resume');
      await repository.replaceFit({
        documentId: id,
        userId,
        fit: null,
        chunks: [passage('fit text')],
      });

      await repository.replaceOverview({ documentId: id, userId, chunks: [passage('overview')] });

      expect((await rows(id)).map(([, section]) => section)).toEqual([
        'requirements',
        'requirements',
        'profile',
        'fit',
        'overview',
      ]);
    });
  });

  describe('reading the passages of a source back', () => {
    it('gives the text passages of that document only, in order, without the generated ones', async () => {
      const resume = await readyDocument('resume');
      await repository.replaceOverview({
        documentId: resume.id,
        userId: resume.userId,
        chunks: [passage('overview')],
      });
      await repository.replaceFit({
        documentId: resume.id,
        userId: resume.userId,
        fit: null,
        chunks: [passage('fit')],
      });

      expect(await repository.careerPassages(resume.id, resume.userId)).toEqual([
        'first',
        'second',
      ]);
    });

    it('does not read the passages of another document of the same user', async () => {
      const resume = await readyDocument('resume');
      const other = await repository.create({
        userId: resume.userId,
        kind: 'job_posting',
        filename: 'other job',
        mimeType: 'text/plain',
        sizeBytes: 10,
        jobNumber: 1,
      });
      await repository.completeWithChunks({
        documentId: other.id,
        userId: resume.userId,
        pageCount: null,
        chunks: [
          { ...passage('from the job'), ordinal: 0, section: 'requirements' },
          { ...passage('untagged'), ordinal: 1 },
        ],
      });

      expect(await repository.careerPassages(resume.id, resume.userId)).toEqual([
        'first',
        'second',
      ]);
      expect(await repository.careerPassages(other.id, resume.userId)).toEqual([
        'from the job',
        'untagged',
      ]);
    });

    it('does not read the passages of another user', async () => {
      const resume = await readyDocument('resume');
      const [stranger] = await db
        .insert(users)
        .values({ email: 'stranger@example.com', passwordHash: 'hash' })
        .returning();

      expect(await repository.careerPassages(resume.id, stranger!.id)).toEqual([]);
    });
  });

  it('writes the profile passages with the same care', async () => {
    const { id, userId } = await readyDocument('resume');

    await repository.replaceProfile({
      documentId: id,
      userId,
      profile: {
        role: 'resume',
        headline: null,
        skills: [],
        roles: [],
        education: [],
        totalExperienceYears: null,
      },
      chunks: [passage('new profile')],
    });

    expect((await rows(id)).filter(([, section]) => section === 'profile')).toEqual([
      [2, 'profile', 'new profile'],
    ]);
  });
});
