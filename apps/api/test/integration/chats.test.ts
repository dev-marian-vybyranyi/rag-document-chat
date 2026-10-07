import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createChatRepository, DEFAULT_CHAT_TITLE } from '../../src/chat/repository.js';
import { MAX_TITLE_LENGTH } from '../../src/chat/routes.js';
import type { MessageSource } from '../../src/chat/types.js';
import { chats, messages, users } from '../../src/db/schema.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';
const MISSING_ID = '3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10';

describe('chats', () => {
  const db = useTestDb();
  const app = buildTestApp(db);
  const repository = createChatRepository(db);

  async function signedIn(email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  const source: MessageSource = {
    id: 1,
    chunkId: MISSING_ID,
    documentId: MISSING_ID,
    filename: 'handbook.pdf',
    page: 4,
    ordinal: 2,
    excerpt: 'HNSW builds a layered graph.',
    score: 0.78,
    vectorRank: 1,
    keywordScore: 0.4,
    keywordRank: 2,
    fusedScore: 0.032,
  };

  describe('access', () => {
    it.each([
      ['GET', '/chats'],
      ['POST', '/chats'],
      ['GET', `/chats/${MISSING_ID}`],
      ['PATCH', `/chats/${MISSING_ID}`],
      ['DELETE', `/chats/${MISSING_ID}`],
    ])('%s %s requires a signed-in user', async (method, path) => {
      const res = await request(app)[method.toLowerCase() as 'get'](path);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });
  });

  describe('creating', () => {
    it('starts a chat with the default title', async () => {
      const { agent } = await signedIn('ann@example.com');

      const res = await agent.post('/chats').send({});

      expect(res.status).toBe(201);
      expect(res.body.chat).toMatchObject({ title: DEFAULT_CHAT_TITLE });
      expect(res.body.chat.id).toEqual(expect.any(String));
    });

    it('works without a body at all', async () => {
      const { agent } = await signedIn('ann@example.com');

      const res = await agent.post('/chats');

      expect(res.status).toBe(201);
    });

    it('trims a given title', async () => {
      const { agent } = await signedIn('ann@example.com');

      const res = await agent.post('/chats').send({ title: '  Quarterly report  ' });

      expect(res.body.chat.title).toBe('Quarterly report');
    });

    it.each([
      ['blank', '   '],
      ['too long', 'x'.repeat(MAX_TITLE_LENGTH + 1)],
      ['not text', 42],
    ])('rejects a %s title', async (_name, title) => {
      const { agent } = await signedIn('ann@example.com');

      const res = await agent.post('/chats').send({ title });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });

  describe('listing', () => {
    it('is empty for a new user', async () => {
      const { agent } = await signedIn('ann@example.com');

      const res = await agent.get('/chats');

      expect(res.body).toEqual({ chats: [] });
    });

    it('puts the chat with the latest activity first', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const first = await repository.create(userId, 'first');
      const second = await repository.create(userId, 'second');
      await repository.addMessage({ chatId: first.id, role: 'user', content: 'hello' });

      const res = await agent.get('/chats');

      expect(res.body.chats.map((c: { title: string }) => c.title)).toEqual(['first', 'second']);
      expect(res.body.chats[1].id).toBe(second.id);
    });

    it("never shows another user's chats", async () => {
      const ann = await signedIn('ann@example.com');
      const bob = await signedIn('bob@example.com');
      await repository.create(ann.userId, 'ann private');
      await repository.create(bob.userId, 'bob private');

      const res = await bob.agent.get('/chats');

      expect(res.body.chats.map((c: { title: string }) => c.title)).toEqual(['bob private']);
    });
  });

  describe('reading one chat', () => {
    it('returns its messages in the order they were written, with sources', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);
      await repository.addMessage({ chatId: chat.id, role: 'user', content: 'What is HNSW?' });
      await repository.addMessage({
        chatId: chat.id,
        role: 'assistant',
        content: 'A layered graph [1].',
        sources: [source],
        retrieval: {
          query: 'What is HNSW?',
          rewritten: false,
          mode: 'hybrid',
          bestScore: 0.78,
          threshold: 0.65,
          outcome: 'answered',
          timings: { rewriteMs: 0, retrievalMs: 12 },
          closest: [],
        },
      });

      const res = await agent.get(`/chats/${chat.id}`);

      expect(res.status).toBe(200);
      expect(res.body.chat.id).toBe(chat.id);
      expect(res.body.messages).toHaveLength(2);
      expect(res.body.messages[0]).toMatchObject({
        role: 'user',
        content: 'What is HNSW?',
        sources: [],
      });
      expect(res.body.messages[1]).toMatchObject({
        role: 'assistant',
        sources: [source],
        retrieval: {
          query: 'What is HNSW?',
          rewritten: false,
          mode: 'hybrid',
          bestScore: 0.78,
          outcome: 'answered',
        },
      });
    });

    it('does not expose internal columns', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);
      await repository.addMessage({ chatId: chat.id, role: 'user', content: 'hi' });

      const res = await agent.get(`/chats/${chat.id}`);

      expect(Object.keys(res.body.chat).sort()).toEqual(['createdAt', 'id', 'title', 'updatedAt']);
      expect(res.body.messages[0]).not.toHaveProperty('seq');
      expect(res.body.messages[0]).not.toHaveProperty('chatId');
    });

    it('is a 404 for an unknown, malformed or foreign id', async () => {
      const ann = await signedIn('ann@example.com');
      const bob = await signedIn('bob@example.com');
      const chat = await repository.create(ann.userId);

      const results = await Promise.all([
        bob.agent.get(`/chats/${MISSING_ID}`),
        bob.agent.get('/chats/not-a-uuid'),
        bob.agent.get(`/chats/${chat.id}`),
      ]);

      for (const res of results) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
      }
    });
  });

  describe('renaming', () => {
    it('changes the title', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);

      const res = await agent.patch(`/chats/${chat.id}`).send({ title: ' Budget ' });

      expect(res.status).toBe(200);
      expect(res.body.chat.title).toBe('Budget');
      const [stored] = await db.select().from(chats).where(eq(chats.id, chat.id));
      expect(stored!.title).toBe('Budget');
    });

    it('requires a valid title', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId, 'keep me');

      const res = await agent.patch(`/chats/${chat.id}`).send({ title: '' });

      expect(res.status).toBe(400);
      const [stored] = await db.select().from(chats).where(eq(chats.id, chat.id));
      expect(stored!.title).toBe('keep me');
    });

    it("cannot rename another user's chat", async () => {
      const ann = await signedIn('ann@example.com');
      const bob = await signedIn('bob@example.com');
      const chat = await repository.create(ann.userId, 'mine');

      const res = await bob.agent.patch(`/chats/${chat.id}`).send({ title: 'stolen' });

      expect(res.status).toBe(404);
      const [stored] = await db.select().from(chats).where(eq(chats.id, chat.id));
      expect(stored!.title).toBe('mine');
    });
  });

  describe('deleting', () => {
    it('removes the chat and its messages', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);
      await repository.addMessage({ chatId: chat.id, role: 'user', content: 'hi' });

      const res = await agent.delete(`/chats/${chat.id}`);

      expect(res.status).toBe(204);
      expect(await db.select().from(chats)).toHaveLength(0);
      expect(await db.select().from(messages)).toHaveLength(0);
    });

    it("cannot delete another user's chat", async () => {
      const ann = await signedIn('ann@example.com');
      const bob = await signedIn('bob@example.com');
      const chat = await repository.create(ann.userId);

      const res = await bob.agent.delete(`/chats/${chat.id}`);

      expect(res.status).toBe(404);
      expect(await db.select().from(chats)).toHaveLength(1);
    });

    it('goes away with the user', async () => {
      const { userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);
      await repository.addMessage({ chatId: chat.id, role: 'user', content: 'hi' });

      await db.delete(users).where(eq(users.id, userId));

      expect(await db.select().from(chats)).toHaveLength(0);
      expect(await db.select().from(messages)).toHaveLength(0);
    });
  });

  describe('repository', () => {
    it('keeps messages in insertion order even when written in the same instant', async () => {
      const { userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);

      await db.transaction(async (tx) => {
        for (const content of ['one', 'two', 'three']) {
          await tx.insert(messages).values({ chatId: chat.id, role: 'user', content });
        }
      });

      const stored = await repository.messagesOf(chat.id);
      expect(stored.map((m) => m.content)).toEqual(['one', 'two', 'three']);
    });

    it('moves the chat to the top of the list when a message is added', async () => {
      const { userId } = await signedIn('ann@example.com');
      const older = await repository.create(userId, 'older');
      await repository.create(userId, 'newer');

      await repository.addMessage({ chatId: older.id, role: 'user', content: 'ping' });

      const list = await repository.listByUser(userId);
      expect(list.map((c) => c.title)).toEqual(['older', 'newer']);
    });

    it('stores a message without sources as null', async () => {
      const { userId } = await signedIn('ann@example.com');
      const chat = await repository.create(userId);

      const message = await repository.addMessage({ chatId: chat.id, role: 'user', content: 'hi' });

      expect(message.sources).toBeNull();
      expect(message.retrieval).toBeNull();
    });
  });
});
