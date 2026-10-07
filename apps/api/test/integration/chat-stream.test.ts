import { APICallError } from 'ai';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { CHAT_FAILURE_MESSAGES } from '../../src/chat/errors.js';
import { createChatRepository } from '../../src/chat/repository.js';
import type { ChatDeps } from '../../src/chat/responder.js';
import { chunks, documents, messages } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import type { QueryRewriter } from '../../src/rag/rewrite.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import {
  modelStreamBreaking,
  modelStreamFailing,
  modelStreaming,
  streamedPromptText,
} from '../helpers/language-model.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';

interface SseChunk {
  type: string;
  [key: string]: unknown;
}

function parseSse(body: string): SseChunk[] {
  return body
    .split('\n\n')
    .map((block) => block.replace(/^data: /, '').trim())
    .filter((data) => data.length > 0 && data !== '[DONE]')
    .map((data) => JSON.parse(data) as SseChunk);
}

const textOf = (parts: SseChunk[]) =>
  parts
    .filter((p) => p.type === 'text-delta')
    .map((p) => p.delta as string)
    .join('');

describe('POST /chats/:id/messages', () => {
  const db = useTestDb();
  const chats = createChatRepository(db);
  const logger = pino({ level: 'silent' });

  function setup(
    options: {
      model?: ChatDeps['model'];
      embedder?: Embedder;
      rewriter?: QueryRewriter;
    } = {},
  ) {
    const fakeEmbedder = createFakeEmbedder();
    const embedder = options.embedder ?? fakeEmbedder;
    const chat: ChatDeps = {
      retriever: createRetriever({ store: createRetrievalStore(db), embedder, logger }),
      rewriter: options.rewriter ?? createPassthroughRewriter(),
      model: options.model === undefined ? modelStreaming('ok') : options.model,
    };
    return { app: buildTestApp(db, { chat }), embedder: fakeEmbedder };
  }

  async function signedIn(app: ReturnType<typeof setup>['app'], email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  async function addDocument(userId: string, filename: string, passages: string[]) {
    const [doc] = await db
      .insert(documents)
      .values({ userId, filename, mimeType: 'text/plain', sizeBytes: 1, status: 'ready' })
      .returning();
    await db.insert(chunks).values(
      passages.map((content, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        page: ordinal + 1,
        content,
        tokenCount: 5,
        embedding: fakeVector(content),
      })),
    );
    return doc!;
  }

  async function savedMessages(chatId: string, count: number) {
    return vi.waitFor(async () => {
      const stored = await chats.messagesOf(chatId);
      expect(stored).toHaveLength(count);
      return stored;
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  const HNSW = 'HNSW is an approximate nearest neighbour index built on layered graphs.';

  async function ask(agent: ReturnType<typeof request.agent>, chatId: string, content: string) {
    const res = await agent
      .post(`/chats/${chatId}/messages`)
      .buffer(true)
      .parse((r, done) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (piece: string) => (data += piece));
        r.on('end', () => done(null, data));
      })
      .send({ content });
    const body = typeof res.body === 'string' ? res.body : '';
    return {
      res,
      parts: res.headers['content-type']?.includes('text/event-stream') ? parseSse(body) : [],
    };
  }

  describe('request handling', () => {
    it('requires a signed-in user', async () => {
      const { app } = setup();

      const res = await request(app)
        .post('/chats/3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10/messages')
        .send({ content: 'hi' });

      expect(res.status).toBe(401);
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['too long', 'x'.repeat(2001)],
    ])('rejects %s content without storing anything', async (_name, content) => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      const { res } = await ask(agent, chat.id, content);

      expect(res.status).toBe(400);
      expect(await db.select().from(messages)).toHaveLength(0);
    });

    it("is a 404 for another user's chat and stores nothing", async () => {
      const { app } = setup();
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      const chat = await chats.create(ann.userId);

      const { res } = await ask(bob.agent, chat.id, 'hello?');

      expect(res.status).toBe(404);
      expect(await db.select().from(messages)).toHaveLength(0);
    });

    it('is a 503 without storing anything when no model is configured', async () => {
      const { app } = setup({ model: null });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      const { res } = await ask(agent, chat.id, 'hello?');

      expect(res.status).toBe(503);
      expect(JSON.parse(res.body).error.code).toBe('chat_unavailable');
      expect(await db.select().from(messages)).toHaveLength(0);
    });
  });

  describe('a grounded answer', () => {
    it('streams the sources first, then the answer text', async () => {
      const model = modelStreaming('HNSW is a graph index ', '[1].');
      const { app } = setup({ model });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      await addDocument(userId, 'handbook.txt', [HNSW]);
      const chat = await chats.create(userId);

      const { res, parts } = await ask(agent, chat.id, 'What is HNSW?');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(parts[0]!.type).toBe('start');
      const types = parts.map((p) => p.type);
      expect(types.indexOf('data-sources')).toBeLessThan(types.indexOf('text-delta'));
      expect(types).toContain('finish');
      expect(textOf(parts)).toBe('HNSW is a graph index [1].');

      const sourcesPart = parts.find((p) => p.type === 'data-sources')!;
      expect(sourcesPart.data).toMatchObject({
        sources: [{ id: 1, filename: 'handbook.txt', page: 1, excerpt: HNSW }],
        retrieval: { query: 'What is HNSW?', rewritten: false, mode: 'hybrid' },
      });
    });

    it('tells the client which stage it is in without keeping it in the message', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      const { parts } = await ask(agent, chat.id, 'What is HNSW?');

      const stages = parts.filter((p) => p.type === 'data-status');
      expect(stages.map((p) => (p.data as { stage: string }).stage)).toEqual([
        'searching',
        'answering',
      ]);
      expect(stages.every((p) => p.transient === true)).toBe(true);
    });

    it('saves the question and the answer with its sources and retrieval details', async () => {
      const { app } = setup({ model: modelStreaming('A layered ', 'graph [1].') });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      await addDocument(userId, 'handbook.txt', [HNSW]);
      const chat = await chats.create(userId);

      await ask(agent, chat.id, 'What is HNSW?');

      const stored = await savedMessages(chat.id, 2);
      expect(stored.map((m) => [m.role, m.content])).toEqual([
        ['user', 'What is HNSW?'],
        ['assistant', 'A layered graph [1].'],
      ]);
      expect(stored[0]!.sources).toBeNull();
      expect(stored[1]!.sources).toMatchObject([{ id: 1, filename: 'handbook.txt', page: 1 }]);
      expect(stored[1]!.retrieval).toEqual({
        query: 'What is HNSW?',
        rewritten: false,
        mode: 'hybrid',
      });
    });

    it('gives the model the fixed rules and numbered sources from the right user only', async () => {
      const model = modelStreaming('ok');
      const { app } = setup({ model });
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      await addDocument(ann.userId, 'ann.txt', [HNSW]);
      await addDocument(bob.userId, 'bob.txt', ['Bob secret: HNSW internals are confidential.']);
      const chat = await chats.create(ann.userId);

      await ask(ann.agent, chat.id, 'What is HNSW?');

      const system = streamedPromptText(model, 'system');
      const user = streamedPromptText(model, 'user');
      expect(system).toContain('Answer only from the numbered sources');
      expect(user).toContain('<source id="1" document="ann.txt" page="1">');
      expect(user).toContain('Question: What is HNSW?');
      expect(user).not.toContain('Bob secret');
      expect(user).not.toContain('bob.txt');
    });

    it('names a new chat after the first question only', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      await ask(agent, chat.id, 'What is   HNSW?');
      await ask(agent, chat.id, 'And how fast is it?');

      const stored = await chats.findForUser(chat.id, userId);
      expect(stored!.title).toBe('What is HNSW?');
    });

    it('keeps a title the user already chose', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId, 'My notes');

      await ask(agent, chat.id, 'What is HNSW?');

      expect((await chats.findForUser(chat.id, userId))!.title).toBe('My notes');
    });
  });

  describe('follow-up questions', () => {
    it('searches with the rewritten query and passes the history to the model', async () => {
      const model = modelStreaming('Fast [1].');
      const rewriter: QueryRewriter = {
        rewrite: async () => ({ query: 'How fast is HNSW search?', rewritten: true }),
      };
      const { app, embedder } = setup({ model, rewriter });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      await addDocument(userId, 'handbook.txt', [HNSW]);
      const chat = await chats.create(userId);
      await chats.addMessage({ chatId: chat.id, role: 'user', content: 'What is HNSW?' });
      await chats.addMessage({
        chatId: chat.id,
        role: 'assistant',
        content: 'A layered graph index [1].',
      });

      const { parts } = await ask(agent, chat.id, 'How fast is it?');

      expect(embedder.queryCalls).toEqual(['How fast is HNSW search?']);
      const sources = parts.find((p) => p.type === 'data-sources')!;
      expect(sources.data).toMatchObject({
        retrieval: { query: 'How fast is HNSW search?', rewritten: true },
      });
      expect(streamedPromptText(model, 'user')).toContain('What is HNSW?');
      expect(streamedPromptText(model, 'assistant')).toContain('A layered graph index');
      expect(streamedPromptText(model, 'user')).toContain('Question: How fast is it?');
    });

    it('does not send the new question twice', async () => {
      const model = modelStreaming('ok');
      const { app } = setup({ model });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      await ask(agent, chat.id, 'Only once please');

      const occurrences = streamedPromptText(model, 'user').split('Only once please').length - 1;
      expect(occurrences).toBe(1);
    });
  });

  describe('when something fails', () => {
    it('keeps answering from keyword search if the query cannot be embedded', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => [],
        embedQuery: async () => {
          throw new EmbeddingError('rate_limited');
        },
      };
      const { app } = setup({ embedder, model: modelStreaming('From keywords [1].') });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      await addDocument(userId, 'handbook.txt', [HNSW]);
      const chat = await chats.create(userId);

      const { parts } = await ask(agent, chat.id, 'What is HNSW?');

      expect(textOf(parts)).toBe('From keywords [1].');
      const stored = await savedMessages(chat.id, 2);
      expect(stored[1]!.retrieval).toMatchObject({ mode: 'keyword-only' });
    });

    it.each([
      ['a rate limit', 429, 'rate_limited'],
      ['an overloaded model', 503, 'overloaded'],
      ['a rejected key', 403, 'misconfigured'],
    ] as const)('explains %s to the client and saves no answer', async (_name, status, kind) => {
      const apiError = new APICallError({
        message: 'secret upstream detail https://example.test/v1?key=SECRET',
        url: 'https://example.test/v1',
        requestBodyValues: {},
        statusCode: status,
        isRetryable: false,
      });
      const { app } = setup({ model: modelStreamFailing(apiError) });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      const { res, parts } = await ask(agent, chat.id, 'What is HNSW?');

      expect(res.status).toBe(200);
      const error = parts.find((p) => p.type === 'error');
      expect(error!.errorText).toBe(CHAT_FAILURE_MESSAGES[kind]);
      expect(JSON.stringify(parts)).not.toContain('SECRET');
      await settle();
      const stored = await chats.messagesOf(chat.id);
      expect(stored.map((m) => m.role)).toEqual(['user']);
    });

    it('does not save a half-written answer when the model stream breaks', async () => {
      const model = modelStreamBreaking(['Partial ans'], new Error('socket hang up'));
      const { app } = setup({ model });
      const { agent, userId } = await signedIn(app, 'ann@example.com');
      const chat = await chats.create(userId);

      const { parts } = await ask(agent, chat.id, 'What is HNSW?');

      expect(parts.some((p) => p.type === 'error')).toBe(true);
      await settle();
      expect((await chats.messagesOf(chat.id)).map((m) => m.role)).toEqual(['user']);
    });

    it('recovers on the next question after a failed one', async () => {
      const failing = modelStreamFailing(new Error('boom'));
      const failingApp = setup({ model: failing });
      const { agent, userId } = await signedIn(failingApp.app, 'ann@example.com');
      const chat = await chats.create(userId);
      await ask(agent, chat.id, 'First try');

      const model = modelStreaming('Second answer');
      const { app } = setup({ model });
      const second = request.agent(app);
      await second.post('/auth/login').send({ email: 'ann@example.com', password });
      await ask(second, chat.id, 'Second try');

      const user = streamedPromptText(model, 'user');
      expect(user).toContain('Question: Second try');
      expect(user).not.toContain('First try');
      expect((await savedMessages(chat.id, 3)).map((m) => m.content)).toEqual([
        'First try',
        'Second try',
        'Second answer',
      ]);
    });
  });
});
