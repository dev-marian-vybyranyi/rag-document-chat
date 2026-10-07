import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { chunks, documents } from '../../src/db/schema.js';
import { fakeVector } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';
const MISSING_ID = '3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10';

describe('managing documents', () => {
  const db = useTestDb();
  const app = buildTestApp(db);

  async function signedIn(email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  async function addDocument(
    userId: string,
    options: {
      filename?: string;
      status?: 'processing' | 'ready' | 'failed';
      chunkCount?: number;
      error?: string;
      createdAt?: Date;
    } = {},
  ) {
    const { filename = 'notes.txt', status = 'ready', chunkCount = 0, error, createdAt } = options;
    const [document] = await db
      .insert(documents)
      .values({
        userId,
        filename,
        mimeType: 'text/plain',
        sizeBytes: 100,
        status,
        error,
        createdAt,
      })
      .returning();
    if (chunkCount > 0) {
      await db.insert(chunks).values(
        Array.from({ length: chunkCount }, (_, ordinal) => ({
          documentId: document!.id,
          userId,
          ordinal,
          content: `passage ${ordinal}`,
          tokenCount: 3,
          embedding: fakeVector(`passage ${ordinal}`),
        })),
      );
    }
    return document!;
  }

  describe('access', () => {
    it.each([
      ['GET', '/documents'],
      ['GET', `/documents/${MISSING_ID}`],
      ['DELETE', `/documents/${MISSING_ID}`],
    ])('%s %s requires a signed-in user', async (method, path) => {
      const res = await request(app)[method.toLowerCase() as 'get' | 'delete'](path);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });
  });

  describe('GET /documents', () => {
    it('is empty for a new user', async () => {
      const { agent } = await signedIn('ada@example.com');

      const res = await agent.get('/documents');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ documents: [] });
    });

    it('lists the user’s documents, newest first, with their status and passage count', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      await addDocument(userId, {
        filename: 'old.txt',
        chunkCount: 2,
        createdAt: new Date('2026-01-01'),
      });
      await addDocument(userId, {
        filename: 'new.txt',
        status: 'processing',
        createdAt: new Date('2026-02-01'),
      });

      const res = await agent.get('/documents');

      expect(res.body.documents.map((d: { filename: string }) => d.filename)).toEqual([
        'new.txt',
        'old.txt',
      ]);
      expect(res.body.documents[0]).toMatchObject({ status: 'processing', chunkCount: 0 });
      expect(res.body.documents[1]).toMatchObject({ status: 'ready', chunkCount: 2 });
    });

    it('shows why a document failed', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      await addDocument(userId, {
        status: 'failed',
        error: 'The PDF has no selectable text (it may be a scan)',
      });

      const res = await agent.get('/documents');

      expect(res.body.documents[0]).toMatchObject({
        status: 'failed',
        error: 'The PDF has no selectable text (it may be a scan)',
      });
    });

    it('never shows another user’s documents', async () => {
      const ada = await signedIn('ada@example.com');
      const grace = await signedIn('grace@example.com');
      await addDocument(ada.userId, { filename: 'ada-private.txt' });
      await addDocument(grace.userId, { filename: 'grace-private.txt' });

      const res = await grace.agent.get('/documents');

      expect(res.body.documents.map((d: { filename: string }) => d.filename)).toEqual([
        'grace-private.txt',
      ]);
    });

    it('does not expose internal fields such as the owner', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      await addDocument(userId);

      const res = await agent.get('/documents');

      expect(Object.keys(res.body.documents[0]).sort()).toEqual([
        'chunkCount',
        'createdAt',
        'error',
        'filename',
        'id',
        'mimeType',
        'pageCount',
        'sizeBytes',
        'status',
        'suggestions',
      ]);
    });
  });

  describe('GET /documents/:id', () => {
    it('returns the document', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      const doc = await addDocument(userId, { filename: 'a.txt', chunkCount: 3 });

      const res = await agent.get(`/documents/${doc.id}`);

      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({ id: doc.id, filename: 'a.txt', chunkCount: 3 });
    });

    it('answers 404 for an id that does not exist', async () => {
      const { agent } = await signedIn('ada@example.com');

      const res = await agent.get(`/documents/${MISSING_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });

    it('answers 404 for another user’s document, exactly as if it did not exist', async () => {
      const ada = await signedIn('ada@example.com');
      const grace = await signedIn('grace@example.com');
      const doc = await addDocument(ada.userId);

      const foreign = await grace.agent.get(`/documents/${doc.id}`);
      const missing = await grace.agent.get(`/documents/${MISSING_ID}`);

      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
    });

    it.each(['not-a-uuid', '123', 'DROP TABLE documents'])(
      'answers 404 for the malformed id %j',
      async (id) => {
        const { agent } = await signedIn('ada@example.com');

        const res = await agent.get(`/documents/${encodeURIComponent(id)}`);

        expect(res.status).toBe(404);
      },
    );
  });

  describe('DELETE /documents/:id', () => {
    it('deletes the document together with its passages', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      const doc = await addDocument(userId, { chunkCount: 3 });

      const res = await agent.delete(`/documents/${doc.id}`);

      expect(res.status).toBe(204);
      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(chunks)).toEqual([]);
      expect((await agent.get(`/documents/${doc.id}`)).status).toBe(404);
    });

    it('leaves the user’s other documents alone', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      const doomed = await addDocument(userId, { filename: 'doomed.txt', chunkCount: 1 });
      const kept = await addDocument(userId, { filename: 'kept.txt', chunkCount: 2 });

      await agent.delete(`/documents/${doomed.id}`);

      expect(await db.select().from(documents)).toHaveLength(1);
      expect(await db.select().from(chunks).where(eq(chunks.documentId, kept.id))).toHaveLength(2);
    });

    it('answers 404 the second time', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      const doc = await addDocument(userId);
      await agent.delete(`/documents/${doc.id}`);

      const again = await agent.delete(`/documents/${doc.id}`);

      expect(again.status).toBe(404);
    });

    it('cannot delete another user’s document', async () => {
      const ada = await signedIn('ada@example.com');
      const grace = await signedIn('grace@example.com');
      const doc = await addDocument(ada.userId, { chunkCount: 1 });

      const res = await grace.agent.delete(`/documents/${doc.id}`);

      expect(res.status).toBe(404);
      expect(await db.select().from(documents)).toHaveLength(1);
      expect(await db.select().from(chunks)).toHaveLength(1);
    });

    it('can remove a document that is still being processed', async () => {
      const { agent, userId } = await signedIn('ada@example.com');
      const doc = await addDocument(userId, { status: 'processing' });

      const res = await agent.delete(`/documents/${doc.id}`);

      expect(res.status).toBe(204);
    });

    it('answers 404 for a malformed id instead of failing', async () => {
      const { agent } = await signedIn('ada@example.com');

      const res = await agent.delete('/documents/not-a-uuid');

      expect(res.status).toBe(404);
    });
  });

  it('reports no passages yet for a freshly uploaded document', async () => {
    const { agent } = await signedIn('ada@example.com');

    const res = await agent.post('/documents').attach('file', Buffer.from('A note.'), 'a.txt');

    expect(res.body.document).toMatchObject({ status: 'processing', chunkCount: 0 });
  });
});
