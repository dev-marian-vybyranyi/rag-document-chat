import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createChatRepository } from '../../src/chat/repository.js';
import { MAX_SCOPED_SOURCES } from '../../src/chat/routes.js';
import { chats, chunks, documents } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { askQuestion } from '../helpers/chat-client.js';
import { createWordEmbedder, wordVector } from '../helpers/embedder.js';
import { modelStreaming, streamedPromptText } from '../helpers/language-model.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';
const MISSING_ID = '3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10';

describe('choosing the sources a chat searches', () => {
  const db = useTestDb();
  const repository = createChatRepository(db);
  const logger = pino({ level: 'silent' });

  function setup(model = modelStreaming('See [1].')) {
    const embedder = createWordEmbedder();
    const app = buildTestApp(db, {
      chat: {
        retriever: createRetriever({ store: createRetrievalStore(db), embedder, logger }),
        rewriter: createPassthroughRewriter(),
        model,
        relevanceThreshold: -1,
      },
    });
    return { app, model, embedder };
  }

  async function signedIn(app: ReturnType<typeof setup>['app'], email = 'ann@example.com') {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  async function addSource(
    userId: string,
    kind: 'document' | 'repository',
    filename: string,
    passages: Array<{ text: string; path?: string }>,
  ) {
    const [doc] = await db
      .insert(documents)
      .values({ userId, kind, filename, mimeType: 'text/plain', sizeBytes: 1, status: 'ready' })
      .returning();
    await db.insert(chunks).values(
      passages.map((passage, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        content: passage.text,
        tokenCount: 5,
        embedding: wordVector(passage.text),
        path: passage.path ?? null,
        language: passage.path ? 'typescript' : null,
        startLine: passage.path ? 1 : null,
        endLine: passage.path ? 3 : null,
      })),
    );
    return doc!;
  }

  const POLICY = 'The leave policy explains parental leave, vacation days and sick leave.';
  const CODE = 'export function leavePolicy() { return parentalLeave + vacationDays; }';
  const QUESTION = 'What is the leave policy about parental leave and vacation days?';

  async function twoSources(userId: string) {
    const handbook = await addSource(userId, 'document', 'handbook.txt', [{ text: POLICY }]);
    const repo = await addSource(userId, 'repository', 'acme/hr', [
      { text: CODE, path: 'src/leave.ts' },
    ]);
    return { handbook, repo };
  }

  describe('the scope of a chat', () => {
    it('is the whole library unless one was chosen', async () => {
      const { app } = setup();
      const { agent } = await signedIn(app);

      const res = await agent.post('/chats').send({});

      expect(res.status).toBe(201);
      expect(res.body.chat.sourceIds).toBeNull();
    });

    it('can be chosen when the chat is created', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const { repo } = await twoSources(userId);

      const res = await agent.post('/chats').send({ sourceIds: [repo.id] });

      expect(res.status).toBe(201);
      expect(res.body.chat.sourceIds).toEqual([repo.id]);
      expect((await agent.get(`/chats/${res.body.chat.id}`)).body.chat.sourceIds).toEqual([
        repo.id,
      ]);
    });

    it('is changed afterwards, and given back with the library', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const { handbook, repo } = await twoSources(userId);
      const created = await agent.post('/chats').send({ sourceIds: [repo.id] });
      const id = created.body.chat.id as string;

      const narrowed = await agent
        .patch(`/chats/${id}`)
        .send({ sourceIds: [handbook.id, repo.id] });
      const cleared = await agent.patch(`/chats/${id}`).send({ sourceIds: null });

      expect(narrowed.status).toBe(200);
      expect(narrowed.body.chat.sourceIds.sort()).toEqual([handbook.id, repo.id].sort());
      expect(cleared.body.chat.sourceIds).toBeNull();
    });

    it('is kept when the chat is only renamed, and the title is kept when only the scope changes', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const { repo } = await twoSources(userId);
      const created = await agent.post('/chats').send({ title: 'HR', sourceIds: [repo.id] });
      const id = created.body.chat.id as string;

      const renamed = await agent.patch(`/chats/${id}`).send({ title: 'HR code' });
      const rescoped = await agent.patch(`/chats/${id}`).send({ sourceIds: [repo.id] });

      expect(renamed.body.chat).toMatchObject({ title: 'HR code', sourceIds: [repo.id] });
      expect(rescoped.body.chat).toMatchObject({ title: 'HR code', sourceIds: [repo.id] });
    });

    it('can be set together with a new title', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const { handbook } = await twoSources(userId);
      const created = await agent.post('/chats').send({});

      const res = await agent
        .patch(`/chats/${created.body.chat.id}`)
        .send({ title: 'Handbook only', sourceIds: [handbook.id] });

      expect(res.body.chat).toMatchObject({ title: 'Handbook only', sourceIds: [handbook.id] });
    });

    it('lists each source once', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const { repo } = await twoSources(userId);

      const res = await agent.post('/chats').send({ sourceIds: [repo.id, repo.id] });

      expect(res.body.chat.sourceIds).toEqual([repo.id]);
    });

    it.each([
      ['an empty list', { sourceIds: [] }],
      ['something that is not an id', { sourceIds: ['nope'] }],
      ['a list that is not a list', { sourceIds: 'all' }],
      [
        'too many sources',
        { sourceIds: Array.from({ length: MAX_SCOPED_SOURCES + 1 }, () => MISSING_ID) },
      ],
    ])('refuses %s', async (_label, body) => {
      const { app } = setup();
      const { agent } = await signedIn(app);

      const res = await agent.post('/chats').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(await db.select().from(chats)).toEqual([]);
    });

    it('refuses a patch that changes nothing', async () => {
      const { app } = setup();
      const { agent } = await signedIn(app);
      const created = await agent.post('/chats').send({});

      const res = await agent.patch(`/chats/${created.body.chat.id}`).send({});

      expect(res.status).toBe(400);
    });

    it('refuses a source that does not exist or belongs to someone else, without saying which', async () => {
      const { app } = setup();
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      const { repo } = await twoSources(ann.userId);
      const created = await bob.agent.post('/chats').send({});

      const foreign = await bob.agent.post('/chats').send({ sourceIds: [repo.id] });
      const missing = await bob.agent.post('/chats').send({ sourceIds: [MISSING_ID] });
      const patched = await bob.agent
        .patch(`/chats/${created.body.chat.id}`)
        .send({ sourceIds: [repo.id] });

      for (const res of [foreign, missing, patched]) {
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe('One of the chosen sources is not available');
      }
      expect(foreign.body.error.message).toBe(missing.body.error.message);
      const [row] = await db.select().from(chats).where(eq(chats.id, created.body.chat.id));
      expect(row?.sourceIds).toBeNull();
    });

    it("cannot be changed on someone else's chat", async () => {
      const { app } = setup();
      const ann = await signedIn(app, 'ann@example.com');
      const bob = await signedIn(app, 'bob@example.com');
      const { repo } = await twoSources(bob.userId);
      const created = await ann.agent.post('/chats').send({});

      const res = await bob.agent
        .patch(`/chats/${created.body.chat.id}`)
        .send({ sourceIds: [repo.id] });

      expect(res.status).toBe(404);
    });

    it('survives the deletion of a source, which then simply matches nothing', async () => {
      const { app } = setup();
      const { agent, userId } = await signedIn(app);
      const { repo } = await twoSources(userId);
      const created = await agent.post('/chats').send({ sourceIds: [repo.id] });

      await agent.delete(`/documents/${repo.id}`);

      expect((await agent.get(`/chats/${created.body.chat.id}`)).body.chat.sourceIds).toEqual([
        repo.id,
      ]);
    });
  });

  describe('what a question is answered from', () => {
    async function ask(
      ctx: ReturnType<typeof setup>,
      session: Awaited<ReturnType<typeof signedIn>>,
      sourceIds: string[] | null,
    ) {
      const chat = await repository.create(session.userId, undefined, sourceIds);
      const result = await askQuestion(session.agent, chat.id, QUESTION);
      return { ...result, prompt: streamedPromptText(ctx.model, 'user') };
    }

    it('is the whole library when no sources were chosen', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await twoSources(session.userId);

      const { sources } = await ask(ctx, session, null);

      expect(sources.map((s) => s.filename).sort()).toEqual(['acme/hr', 'handbook.txt']);
    });

    it('is only the repository when the chat is about the repository', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const { repo } = await twoSources(session.userId);

      const { sources, prompt } = await ask(ctx, session, [repo.id]);

      expect(sources.map((s) => s.filename)).toEqual(['acme/hr']);
      expect(sources[0]?.code?.path).toBe('src/leave.ts');
      expect(prompt).toContain('leavePolicy');
      expect(prompt).not.toContain('The leave policy explains');
    });

    it('is only the document when the chat is about the document', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const { handbook } = await twoSources(session.userId);

      const { sources, prompt } = await ask(ctx, session, [handbook.id]);

      expect(sources.map((s) => s.filename)).toEqual(['handbook.txt']);
      expect(sources[0]).not.toHaveProperty('code');
      expect(prompt).not.toContain('leavePolicy');
    });

    it('is the chosen sources, not more, when several are chosen out of many', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const { handbook, repo } = await twoSources(session.userId);
      await addSource(session.userId, 'document', 'other.txt', [
        { text: 'Another leave policy for vacation days and parental leave.' },
      ]);

      const { sources } = await ask(ctx, session, [handbook.id, repo.id]);

      expect(sources.map((s) => s.filename).sort()).toEqual(['acme/hr', 'handbook.txt']);
    });

    it('has no sources to use when the only chosen one was deleted, and says so without calling the model', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const { repo } = await twoSources(session.userId);
      const chat = await repository.create(session.userId, undefined, [repo.id]);
      await session.agent.delete(`/documents/${repo.id}`);

      const { sources, retrieval } = await askQuestion(session.agent, chat.id, QUESTION);

      expect(sources).toEqual([]);
      expect(retrieval?.outcome).toBe('declined');
      expect(ctx.model.doStreamCalls).toHaveLength(0);
    });

    it('does not reach another user’s source even when its id is stored in the chat', async () => {
      const ctx = setup();
      const ann = await signedIn(ctx.app, 'ann@example.com');
      const bob = await signedIn(ctx.app, 'bob@example.com');
      const { repo } = await twoSources(ann.userId);
      const chat = await repository.create(bob.userId, undefined, [repo.id]);

      const { sources } = await askQuestion(bob.agent, chat.id, QUESTION);

      expect(sources).toEqual([]);
    });

    it('applies to every question of the chat, not only the first', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const { repo } = await twoSources(session.userId);
      const chat = await repository.create(session.userId, undefined, [repo.id]);

      const first = await askQuestion(session.agent, chat.id, QUESTION);
      const second = await askQuestion(session.agent, chat.id, 'And what about the vacation days?');

      for (const { sources } of [first, second]) {
        expect(sources.every((s) => s.filename === 'acme/hr')).toBe(true);
      }
    });
  });
});
