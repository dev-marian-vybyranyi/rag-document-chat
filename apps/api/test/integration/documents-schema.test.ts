import { cosineDistance, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../src/db/errors.js';
import { chunks, documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import { useTestDb } from './helpers.js';

function axisVector(axis: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));
}

describe('documents and chunks schema', () => {
  const db = useTestDb();

  async function createUser(email = 'ada@example.com') {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function createDocument(userId: string, filename = 'notes.txt') {
    const [doc] = await db
      .insert(documents)
      .values({ userId, filename, mimeType: 'text/plain', sizeBytes: 10 })
      .returning();
    return doc!;
  }

  const chunkFor = (
    doc: { id: string; userId: string },
    ordinal: number,
    content = `chunk ${ordinal}`,
    embedding = axisVector(ordinal),
  ) => ({
    documentId: doc.id,
    userId: doc.userId,
    ordinal,
    content,
    tokenCount: 5,
    embedding,
  });

  describe('documents', () => {
    it('start out as "processing" with no error', async () => {
      const user = await createUser();

      const doc = await createDocument(user.id);

      expect(doc.status).toBe('processing');
      expect(doc.error).toBeNull();
      expect(doc.pageCount).toBeNull();
    });

    it('only accept the known statuses', async () => {
      const user = await createUser();

      const bogus = db.insert(documents).values({
        userId: user.id,
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: 'archived' as never,
      });

      await expect(bogus).rejects.toThrow();
    });

    it('are deleted together with their owner', async () => {
      const user = await createUser();
      await createDocument(user.id);

      await db.delete(users).where(eq(users.id, user.id));

      expect(await db.select().from(documents)).toEqual([]);
    });
  });

  describe('chunks', () => {
    it('are deleted together with their document', async () => {
      const user = await createUser();
      const doc = await createDocument(user.id);
      await db.insert(chunks).values([chunkFor(doc, 0), chunkFor(doc, 1)]);

      await db.delete(documents).where(eq(documents.id, doc.id));

      expect(await db.select().from(chunks)).toEqual([]);
    });

    it('are deleted together with their owner', async () => {
      const user = await createUser();
      const doc = await createDocument(user.id);
      await db.insert(chunks).values(chunkFor(doc, 0));

      await db.delete(users).where(eq(users.id, user.id));

      expect(await db.select().from(chunks)).toEqual([]);
    });

    it('must belong to an existing document', async () => {
      const user = await createUser();

      const orphan = db
        .insert(chunks)
        .values(chunkFor({ id: '00000000-0000-0000-0000-000000000000', userId: user.id }, 0));

      await expect(orphan).rejects.toSatisfy((e) => pgErrorCode(e) === PG_FOREIGN_KEY_VIOLATION);
    });

    it('cannot repeat a position within one document, but can in another', async () => {
      const user = await createUser();
      const first = await createDocument(user.id, 'first.txt');
      const second = await createDocument(user.id, 'second.txt');
      await db.insert(chunks).values(chunkFor(first, 0));

      const duplicate = db.insert(chunks).values(chunkFor(first, 0));

      await expect(duplicate).rejects.toSatisfy((e) => pgErrorCode(e) === PG_UNIQUE_VIOLATION);
      await expect(db.insert(chunks).values(chunkFor(second, 0))).resolves.toBeDefined();
    });

    it('reject an embedding of the wrong dimensionality', async () => {
      const user = await createUser();
      const doc = await createDocument(user.id);

      const wrongSize = db.insert(chunks).values(chunkFor(doc, 0, 'text', [0.1, 0.2, 0.3]));

      await expect(wrongSize).rejects.toThrow();
    });
  });

  describe('retrieval', () => {
    it('finds the closest chunk first by cosine distance', async () => {
      const user = await createUser();
      const doc = await createDocument(user.id);
      await db
        .insert(chunks)
        .values([
          chunkFor(doc, 0, 'about cats'),
          chunkFor(doc, 1, 'about dogs'),
          chunkFor(doc, 2, 'about birds'),
        ]);

      const query = axisVector(1).map((v, i) => (i === 0 ? 0.2 : v));
      const nearest = await db
        .select({ content: chunks.content })
        .from(chunks)
        .orderBy(cosineDistance(chunks.embedding, query))
        .limit(3);

      expect(nearest.map((c) => c.content)).toEqual(['about dogs', 'about cats', 'about birds']);
    });

    it('fills the keyword search vector itself and matches inflected words', async () => {
      const user = await createUser();
      const doc = await createDocument(user.id);
      await db
        .insert(chunks)
        .values([
          chunkFor(doc, 0, 'Embeddings turn sentences into vectors'),
          chunkFor(doc, 1, 'Postgres stores relational data'),
        ]);

      const matches = await db
        .select({ content: chunks.content })
        .from(chunks)
        .where(sql`${chunks.searchVector} @@ plainto_tsquery('english', 'vector')`);

      expect(matches).toEqual([{ content: 'Embeddings turn sentences into vectors' }]);
    });

    it('has an HNSW index for vectors and a GIN index for keywords', async () => {
      const result = await db.execute<{ indexname: string; indexdef: string }>(
        sql`select indexname, indexdef from pg_indexes where tablename = 'chunks'`,
      );
      const definitions = Object.fromEntries(result.rows.map((r) => [r.indexname, r.indexdef]));

      expect(definitions['chunks_embedding_idx']).toMatch(/USING hnsw .*vector_cosine_ops/);
      expect(definitions['chunks_search_vector_idx']).toMatch(/USING gin/);
    });
  });
});
