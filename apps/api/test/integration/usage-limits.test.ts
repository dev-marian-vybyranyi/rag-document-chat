import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createChatRepository } from '../../src/chat/repository.js';
import type { ChatDeps } from '../../src/chat/responder.js';
import { documents, messages } from '../../src/db/schema.js';
import type { UsageLimits } from '../../src/http/limits.js';
import type { ChatRateLimits, UploadRateLimit } from '../../src/http/rate-limit.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { modelStreaming } from '../helpers/language-model.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import { pino } from 'pino';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';

describe('usage limits', () => {
  const db = useTestDb();
  const chats = createChatRepository(db);

  function setup(
    options: {
      chatRateLimits?: ChatRateLimits;
      uploadRateLimit?: UploadRateLimit;
      usageLimits?: Partial<UsageLimits>;
    } = {},
  ) {
    const model = modelStreaming('ok');
    const chat: ChatDeps = {
      retriever: createRetriever({
        store: createRetrievalStore(db),
        embedder: createFakeEmbedder(),
        logger: pino({ level: 'silent' }),
      }),
      rewriter: createPassthroughRewriter(),
      model,
      relevanceThreshold: -1,
    };
    const app = buildTestApp(db, {
      chat,
      chatRateLimits: options.chatRateLimits,
      uploadRateLimit: options.uploadRateLimit,
      usageLimits: {
        maxDocumentsPerUser: 100,
        maxChatsPerUser: 100,
        maxMessagesPerChat: 100,
        ...options.usageLimits,
      },
    });
    return { app, model };
  }

  async function signedIn(app: ReturnType<typeof setup>['app'], email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  const ask = (agent: ReturnType<typeof request.agent>, chatId: string) =>
    agent.post(`/chats/${chatId}/messages`).send({ content: 'What is HNSW?' });

  describe('questions per user', () => {
    it('are limited per minute, with a message that says how long to wait', async () => {
      const { app, model } = setup({ chatRateLimits: { perMinute: 2, perDay: 100 } });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);
      await ask(agent, chat.id);
      await ask(agent, chat.id);
      const calls = model.doStreamCalls.length;
      const stored = await db.select().from(messages);

      const blocked = await ask(agent, chat.id);

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(blocked.body.error.message).toMatch(
        /too quickly.*Try again in \d+ (seconds?|minutes?)\./,
      );
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(model.doStreamCalls).toHaveLength(calls);
      expect(await db.select().from(messages)).toHaveLength(stored.length);
    });

    it('are limited per day, with its own message', async () => {
      const { app } = setup({ chatRateLimits: { perMinute: 100, perDay: 1 } });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);
      await ask(agent, chat.id);

      const blocked = await ask(agent, chat.id);

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.message).toMatch(
        /daily limit of 1 question\..*Try again in \d+ hours/,
      );
    });

    it('are counted per user, so one account cannot use up another one', async () => {
      const { app } = setup({ chatRateLimits: { perMinute: 1, perDay: 100 } });
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      const annChat = await chats.create(ann.userId);
      const bobChat = await chats.create(bob.userId);
      await ask(ann.agent, annChat.id);

      expect((await ask(ann.agent, annChat.id)).status).toBe(429);
      expect((await ask(bob.agent, bobChat.id)).status).toBe(200);
    });

    it('leave reading the conversation and everything else alone', async () => {
      const { app } = setup({ chatRateLimits: { perMinute: 1, perDay: 100 } });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);
      await ask(agent, chat.id);
      await ask(agent, chat.id);

      expect((await agent.get(`/chats/${chat.id}`)).status).toBe(200);
      expect((await agent.get('/chats')).status).toBe(200);
      expect((await agent.get('/documents')).status).toBe(200);
    });

    it('still require a signed-in user before counting anything', async () => {
      const { app } = setup({ chatRateLimits: { perMinute: 1, perDay: 100 } });

      const res = await request(app)
        .post('/chats/3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10/messages')
        .send({ content: 'hi' });

      expect(res.status).toBe(401);
    });
  });

  describe('conversations', () => {
    it('are capped per user, and room is made by deleting one', async () => {
      const { app } = setup({ usageLimits: { maxChatsPerUser: 2 } });
      const ann = await signedIn(app, 'ann@example.com');
      const first = await ann.agent.post('/chats').send({});
      await ann.agent.post('/chats').send({});

      const blocked = await ann.agent.post('/chats').send({});
      await ann.agent.delete(`/chats/${first.body.chat.id}`);
      const afterDelete = await ann.agent.post('/chats').send({});

      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('chat_limit');
      expect(blocked.body.error.message).toContain('limit of 2 conversations');
      expect(afterDelete.status).toBe(201);
    });

    it("do not count another user's conversations", async () => {
      const { app } = setup({ usageLimits: { maxChatsPerUser: 1 } });
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      await ann.agent.post('/chats').send({});

      expect((await bob.agent.post('/chats').send({})).status).toBe(201);
    });

    it('stop taking questions when they get too long, without storing or answering', async () => {
      const { app, model } = setup({ usageLimits: { maxMessagesPerChat: 2 } });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);
      expect((await ask(agent, chat.id)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const stored = await chats.messagesOf(chat.id);
      const calls = model.doStreamCalls.length;

      const blocked = await ask(agent, chat.id);

      expect(stored).toHaveLength(2);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('chat_full');
      expect(blocked.body.error.message).toContain('Start a new chat');
      expect(await chats.messagesOf(chat.id)).toHaveLength(2);
      expect(model.doStreamCalls).toHaveLength(calls);
    });
  });

  describe('documents', () => {
    const upload = (agent: ReturnType<typeof request.agent>, name = 'notes.txt') =>
      agent.post('/documents').attach('file', Buffer.from('hello world, this is text'), name);

    it('are capped per user, and room is made by deleting one', async () => {
      const { app } = setup({ usageLimits: { maxDocumentsPerUser: 1 } });
      const ann = await signedIn(app, 'ann@example.com');
      const first = await upload(ann.agent);

      const blocked = await upload(ann.agent, 'second.txt');
      await ann.agent.delete(`/documents/${first.body.document.id}`);
      const afterDelete = await upload(ann.agent, 'third.txt');

      expect(first.status).toBe(202);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('document_limit');
      expect(blocked.body.error.message).toContain('limit of 1 document.');
      expect(afterDelete.status).toBe(202);
      expect(await db.select().from(documents)).toHaveLength(1);
    });

    it("do not count another user's documents", async () => {
      const { app } = setup({ usageLimits: { maxDocumentsPerUser: 1 } });
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      await upload(ann.agent);

      expect((await upload(bob.agent)).status).toBe(202);
    });

    it('can be uploaded only so often, whatever happens to the earlier ones', async () => {
      const { app } = setup({ uploadRateLimit: { perHour: 2 } });
      const ann = await signedIn(app, 'ann@example.com');
      for (const name of ['a.txt', 'b.txt']) {
        const res = await upload(ann.agent, name);
        await ann.agent.delete(`/documents/${res.body.document.id}`);
      }

      const blocked = await upload(ann.agent, 'c.txt');

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(blocked.body.error.message).toMatch(
        /Too many uploads.*Try again in \d+ (minutes?|hours?)\./,
      );
    });
  });
});
