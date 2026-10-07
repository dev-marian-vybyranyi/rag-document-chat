import { describe, expect, it } from 'vitest';
import { chunks, documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { useTestDb } from './helpers.js';

const axis = (index: number, weights: Record<number, number> = {}): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => weights[i] ?? (i === index ? 1 : 0));

describe('retrieval queries', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function createDocument(userId: string, filename: string) {
    const [doc] = await db
      .insert(documents)
      .values({ userId, filename, mimeType: 'text/plain', sizeBytes: 1, status: 'ready' })
      .returning();
    return doc!;
  }

  async function addChunks(
    doc: { id: string; userId: string },
    rows: Array<{ content: string; embedding?: number[]; page?: number | null }>,
  ) {
    await db.insert(chunks).values(
      rows.map((row, ordinal) => ({
        documentId: doc.id,
        userId: doc.userId,
        ordinal,
        page: row.page ?? null,
        content: row.content,
        tokenCount: 5,
        embedding: row.embedding ?? axis(ordinal % EMBEDDING_DIMENSIONS),
      })),
    );
  }

  async function seedTwoUsers() {
    const ada = await createUser('ada@example.com');
    const grace = await createUser('grace@example.com');
    const adaDoc = await createDocument(ada.id, 'ada-notes.txt');
    const graceDoc = await createDocument(grace.id, 'grace-notes.txt');
    return { ada, grace, adaDoc, graceDoc };
  }

  describe('by vector', () => {
    it('returns the closest chunks first, with cosine similarity as the score', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [
        { content: 'far away', embedding: axis(10) },
        { content: 'exact match', embedding: axis(1) },
        { content: 'somewhat close', embedding: axis(1, { 1: 1, 2: 1 }) },
      ]);

      const results = await store.vectorSearch(ada.id, axis(1), 3);

      expect(results.map((r) => r.content)).toEqual(['exact match', 'somewhat close', 'far away']);
      expect(results[0]!.score).toBeCloseTo(1, 5);
      expect(results[1]!.score).toBeCloseTo(Math.SQRT1_2, 3);
      expect(results[2]!.score).toBeCloseTo(0, 5);
    });

    it('carries what the answer needs to cite: document name, page and position', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [{ content: 'first' }, { content: 'second', page: 4 }]);

      const [hit] = await store.vectorSearch(ada.id, axis(1), 1);

      expect(hit).toMatchObject({
        chunkId: expect.any(String),
        documentId: adaDoc.id,
        filename: 'ada-notes.txt',
        ordinal: 1,
        page: 4,
        content: 'second',
      });
    });

    it('returns no more than the limit', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(
        adaDoc,
        Array.from({ length: 10 }, (_, i) => ({ content: `chunk ${i}` })),
      );

      expect(await store.vectorSearch(ada.id, axis(0), 4)).toHaveLength(4);
      expect(await store.vectorSearch(ada.id, axis(0), 0)).toEqual([]);
    });

    it('never returns another user’s chunks, even when they match the query exactly', async () => {
      const { ada, grace, adaDoc, graceDoc } = await seedTwoUsers();
      await addChunks(graceDoc, [{ content: 'grace secret', embedding: axis(1) }]);
      await addChunks(adaDoc, [{ content: 'ada note', embedding: axis(50) }]);

      const results = await store.vectorSearch(ada.id, axis(1), 5);

      expect(results.map((r) => r.content)).toEqual(['ada note']);
      expect((await store.vectorSearch(grace.id, axis(1), 5)).map((r) => r.content)).toEqual([
        'grace secret',
      ]);
    });

    it('still fills the limit for a user whose chunks are all farther away than many others’', async () => {
      const { ada, grace, adaDoc, graceDoc } = await seedTwoUsers();
      await addChunks(
        graceDoc,
        Array.from({ length: 300 }, (_, i) => ({
          content: `grace ${i}`,
          embedding: axis(1, { 1: 1, [2 + (i % 500)]: 0.05 }),
        })),
      );
      await addChunks(
        adaDoc,
        Array.from({ length: 6 }, (_, i) => ({ content: `ada ${i}`, embedding: axis(100 + i) })),
      );

      const results = await store.vectorSearch(ada.id, axis(1), 6);

      expect(results).toHaveLength(6);
      expect(results.every((r) => r.content.startsWith('ada'))).toBe(true);
      expect(grace.id).not.toBe(ada.id);
    });

    it('is empty for a user with no documents', async () => {
      const { ada } = await seedTwoUsers();

      expect(await store.vectorSearch(ada.id, axis(1), 5)).toEqual([]);
    });

    it('breaks ties by document and position, so results are repeatable', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [
        { content: 'one', embedding: axis(7) },
        { content: 'two', embedding: axis(7) },
        { content: 'three', embedding: axis(7) },
      ]);

      const results = await store.vectorSearch(ada.id, axis(7), 3);

      expect(results.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    });
  });

  describe('by keyword', () => {
    it('finds chunks that contain the words, including other forms of them', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [
        { content: 'Vectors are stored in an index.' },
        { content: 'Bread needs flour and water.' },
      ]);

      const results = await store.keywordSearch(ada.id, 'How is a vector stored?', 5);

      expect(results.map((r) => r.content)).toEqual(['Vectors are stored in an index.']);
    });

    it('does not require every word of the question to be present', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [{ content: 'HNSW is a graph index.' }]);

      const results = await store.keywordSearch(
        ada.id,
        'What does HNSW stand for in databases?',
        5,
      );

      expect(results).toHaveLength(1);
    });

    it('ranks the chunk that matches more of the words higher', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [
        { content: 'The index is fast.' },
        { content: 'The graph index speeds up nearest neighbour search.' },
        { content: 'Unrelated text about bread.' },
      ]);

      const results = await store.keywordSearch(ada.id, 'graph index nearest neighbour', 5);

      expect(results.map((r) => r.content)).toEqual([
        'The graph index speeds up nearest neighbour search.',
        'The index is fast.',
      ]);
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });

    it('carries the citation details of each hit', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [{ content: 'Chunking splits text.', page: 3 }]);

      const [hit] = await store.keywordSearch(ada.id, 'chunking', 5);

      expect(hit).toMatchObject({
        documentId: adaDoc.id,
        filename: 'ada-notes.txt',
        ordinal: 0,
        page: 3,
        content: 'Chunking splits text.',
      });
    });

    it('returns no more than the limit', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(
        adaDoc,
        Array.from({ length: 10 }, (_, i) => ({ content: `retrieval ${i}` })),
      );

      expect(await store.keywordSearch(ada.id, 'retrieval', 3)).toHaveLength(3);
      expect(await store.keywordSearch(ada.id, 'retrieval', 0)).toEqual([]);
    });

    it('never returns another user’s chunks', async () => {
      const { ada, grace, adaDoc, graceDoc } = await seedTwoUsers();
      await addChunks(graceDoc, [{ content: 'Grace wrote about retrieval.' }]);
      await addChunks(adaDoc, [{ content: 'Ada wrote about retrieval too.' }]);

      const results = await store.keywordSearch(ada.id, 'retrieval', 5);

      expect(results.map((r) => r.content)).toEqual(['Ada wrote about retrieval too.']);
      expect((await store.keywordSearch(grace.id, 'retrieval', 5)).map((r) => r.content)).toEqual([
        'Grace wrote about retrieval.',
      ]);
    });

    it.each(['', '   ', 'the and of', '??? !!!'])(
      'finds nothing for the query %j',
      async (query) => {
        const { ada, adaDoc } = await seedTwoUsers();
        await addChunks(adaDoc, [{ content: 'The retrieval of the data.' }]);

        expect(await store.keywordSearch(ada.id, query, 5)).toEqual([]);
      },
    );

    it.each([
      "foo & bar | baz !qux (quux) :* 'quote'",
      'a <-> b',
      'select * from users; --',
      'unbalanced ( paren',
      '"unterminated quote',
    ])('treats search-syntax characters in %j as plain text instead of failing', async (query) => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [{ content: 'foo bar baz are placeholder words.' }]);

      await expect(store.keywordSearch(ada.id, query, 5)).resolves.toBeDefined();
    });

    it('is repeatable when scores tie', async () => {
      const { ada, adaDoc } = await seedTwoUsers();
      await addChunks(adaDoc, [
        { content: 'retrieval notes' },
        { content: 'retrieval notes' },
        { content: 'retrieval notes' },
      ]);

      const results = await store.keywordSearch(ada.id, 'retrieval', 3);

      expect(results.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    });
  });
});
