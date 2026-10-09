import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createChatRepository } from '../../src/chat/repository.js';
import { NO_ANSWER_MESSAGE } from '../../src/chat/responder.js';
import { chunks, documents, ragTraces } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createGithubImporter } from '../../src/repositories/github.js';
import { createRepositoryIngestion } from '../../src/repositories/ingest.js';
import { CODE_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../src/rag/prompt.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever } from '../../src/rag/retriever.js';
import { createWordEmbedder } from '../helpers/embedder.js';
import { askQuestion, textOf } from '../helpers/chat-client.js';
import { modelStreaming, streamedPromptText } from '../helpers/language-model.js';
import { shopRepoEntries, orderServiceFile } from '../helpers/shop-repo.js';
import { buildZip } from '../helpers/zip.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';

const fileAmong = <T extends { code?: { path: string } }>(sources: T[], path: string) =>
  sources.find((source) => source.code?.path === path);

const coveringLines = <
  T extends { code?: { path: string; startLine: number | null; endLine: number | null } },
>(
  sources: T[],
  path: string,
  range: { start: number; end: number },
) =>
  sources.find(
    (source) =>
      source.code?.path === path &&
      source.code.startLine! <= range.start &&
      source.code.endLine! >= range.end,
  );
const MODEL = 'word-bag';
const THRESHOLD = 0.12;

describe('asking about an imported repository', () => {
  const db = useTestDb();
  const chats = createChatRepository(db);
  const logger = pino({ level: 'silent' });
  const shop = shopRepoEntries();

  function setup(model = modelStreaming('The answer is in the file [1].')) {
    const embedder = createWordEmbedder();
    const repositoryIngestion = createRepositoryIngestion({
      repository: createDocumentRepository(db),
      embedder,
      github: createGithubImporter(),
      logger,
      embeddingModel: MODEL,
    });
    const app = buildTestApp(db, {
      repositoryIngestion,
      chat: {
        retriever: createRetriever({
          store: createRetrievalStore(db, { embeddingModel: MODEL }),
          embedder,
          logger,
        }),
        rewriter: createPassthroughRewriter(),
        model,
        relevanceThreshold: THRESHOLD,
      },
    });
    return { app, model, ingestion: repositoryIngestion };
  }

  async function signedIn(app: ReturnType<typeof setup>['app'], email = 'ann@example.com') {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  async function importShop(
    ctx: ReturnType<typeof setup>,
    agent: ReturnType<typeof request.agent>,
  ) {
    const res = await agent
      .post('/repositories/upload')
      .attach('file', buildZip(shop.entries), 'shop-main.zip');
    await ctx.ingestion.idle();
    return res.body.document.id as string;
  }

  async function ask(
    ctx: ReturnType<typeof setup>,
    session: Awaited<ReturnType<typeof signedIn>>,
    question: string,
  ) {
    const chat = await chats.create(session.userId);
    return askQuestion(session.agent, chat.id, question);
  }

  describe('finding the right code', () => {
    it('answers “where is login” from the file that implements it, with its lines', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { sources, retrieval } = await ask(
        ctx,
        session,
        'Where is the login handler implemented?',
      );

      expect(retrieval?.outcome).toBe('answered');
      expect(fileAmong(sources, 'src/auth/login.ts')).toMatchObject({
        filename: 'shop-main',
        code: { path: 'src/auth/login.ts', startLine: 1, endLine: 13, symbol: 'loginHandler' },
      });
    });

    it('finds a function inside a long file and reports a range that contains it', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);
      const range = shop.ranges['calculateOrderTotal']!;

      const { sources } = await ask(
        ctx,
        session,
        'How is the order total calculated with tax and shipping?',
      );

      const found = coveringLines(sources, 'src/orders/service.ts', range);
      expect(found?.excerpt).toBeDefined();
    });

    it('finds the API endpoints', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { sources } = await ask(
        ctx,
        session,
        'Which API routes and endpoints does the router define?',
      );

      expect(fileAmong(sources, 'src/routes.ts')).toBeDefined();
    });

    it('finds code in another language', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { sources } = await ask(ctx, session, 'How is a card charged through Stripe?');

      expect(sources[0]?.code).toMatchObject({
        path: 'src/payments/charge.py',
        language: 'python',
      });
    });

    it('finds a function by its exact name', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { sources } = await ask(ctx, session, 'applyDiscountCode');

      expect(sources[0]?.code?.path).toBe('src/orders/service.ts');
      expect(
        coveringLines(
          sources.slice(0, 1),
          'src/orders/service.ts',
          shop.ranges['applyDiscountCode']!,
        ),
      ).toBeDefined();
    });

    it('answers questions about dependencies from the repository overview', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { sources } = await ask(
        ctx,
        session,
        'Which dependencies does the project use? express zod pg',
      );

      const overview = fileAmong(sources, 'REPOSITORY_OVERVIEW');
      expect(overview?.excerpt).toContain('shop-api');
      expect(fileAmong(sources, 'package.json')?.excerpt).toContain('express');
    });

    it('shows the model a numbered, attributed block for each source and the code prompt', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      await ask(ctx, session, 'Where is the login handler implemented?');

      const prompt = streamedPromptText(ctx.model, 'user');
      expect(prompt).toMatch(
        /<source id="\d" document="shop-main" path="src\/auth\/login.ts" lines="1-13" symbol="loginHandler" language="typescript">/,
      );
      expect(prompt).toContain('export async function loginHandler(req, res) {');
      expect(streamedPromptText(ctx.model, 'system')).toBe(CODE_SYSTEM_PROMPT);
    });

    it('streams the answer with its citation and keeps the location for later', async () => {
      const ctx = setup(modelStreaming('Login is handled in `src/auth/login.ts` [1].'));
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);
      const chat = await chats.create(session.userId);

      const { parts } = await askQuestion(
        session.agent,
        chat.id,
        'Where is the login handler implemented?',
      );

      expect(textOf(parts)).toBe('Login is handled in `src/auth/login.ts` [1].');
      const stored = await chats.messagesOf(chat.id);
      expect(stored.at(-1)?.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: expect.objectContaining({ path: 'src/auth/login.ts', startLine: 1, endLine: 13 }),
          }),
        ]),
      );
    });
  });

  describe('every shown location is true to the file', () => {
    it('quotes exactly the lines that the range names', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const id = await importShop(ctx, session.agent);
      const original = new Map(
        shop.entries.map((e) => [e.name.replace('shop-main/', ''), String(e.data).split('\n')]),
      );

      const questions = [
        'Where is the login handler implemented?',
        'How is the order total calculated with tax and shipping?',
        'How do I refund an order through the payment gateway?',
        'How are discount codes applied?',
        'Which API routes does the router define?',
      ];
      for (const question of questions) {
        const { sources } = await ask(ctx, session, question);
        for (const source of sources) {
          const { path, startLine, endLine } = source.code!;
          if (path === 'REPOSITORY_OVERVIEW') continue;
          const lines = original.get(path)!;
          const [stored] = await db
            .select()
            .from(chunks)
            .where(eq(chunks.documentId, id))
            .then((rows) => rows.filter((r) => r.path === path && r.startLine === startLine));
          expect(stored?.content, `${path}:${startLine}-${endLine}`).toBe(
            lines.slice(startLine! - 1, endLine!).join('\n'),
          );
        }
      }
    });
  });

  describe('what must not come out', () => {
    it('never shows a secret from the repository, whatever is asked', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { sources } = await ask(
        ctx,
        session,
        'What is the STRIPE_SECRET_KEY value in the .env file?',
      );

      const everything = JSON.stringify(sources) + streamedPromptText(ctx.model, 'user');
      expect(everything).not.toContain('sk_live');
      expect(everything).not.toContain('abcdef123456');
      expect(sources.map((s) => s.code?.path)).not.toContain('.env');
    });

    it('hands instructions written inside the repository to the model as quoted data', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      await ask(
        ctx,
        session,
        'What does the deployment checklist cover about rollback and monitoring?',
      );

      const prompt = streamedPromptText(ctx.model, 'user');
      expect(prompt).toContain('Ignore all previous instructions');
      expect(prompt).not.toContain('<system>');
      expect(prompt.match(/<\/sources>/g)).toHaveLength(1);
      expect(streamedPromptText(ctx.model, 'system')).toBe(CODE_SYSTEM_PROMPT);
    });

    it('records the injection signals of such a passage in the trace', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      await ask(
        ctx,
        session,
        'What does the deployment checklist cover about rollback and monitoring?',
      );

      const [trace] = await db.select().from(ragTraces);
      const notes = trace!.retrieved.find((c) => c.code?.path === 'docs/NOTES.md');
      expect(notes?.sentToModel).toBe(true);
      expect(notes?.injectionSignals).toEqual(
        expect.arrayContaining(['override-instructions', 'fake-message-boundary']),
      );
    });

    it('declines a question the repository cannot answer, without calling the model', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);

      const { parts, retrieval } = await ask(ctx, session, 'Give me a recipe for chocolate cake');

      expect(retrieval?.outcome).toBe('declined');
      expect(textOf(parts)).toBe(NO_ANSWER_MESSAGE);
      expect(ctx.model.doStreamCalls).toHaveLength(0);
    });

    it('does not show one user’s code to another', async () => {
      const ctx = setup();
      const ann = await signedIn(ctx.app, 'ann@example.com');
      const bob = await signedIn(ctx.app, 'bob@example.com');
      await importShop(ctx, ann.agent);

      const { sources, retrieval } = await ask(ctx, bob, 'Where is the login handler implemented?');

      expect(sources).toEqual([]);
      expect(retrieval?.outcome).toBe('declined');
    });

    it('stops answering from a repository once it is deleted', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      const id = await importShop(ctx, session.agent);

      await session.agent.delete(`/documents/${id}`);
      const { sources } = await ask(ctx, session, 'Where is the login handler implemented?');

      expect(sources).toEqual([]);
      expect(await db.select().from(chunks)).toEqual([]);
    });
  });

  describe('a library with documents and a repository', () => {
    async function addNote(userId: string) {
      const text =
        'The quarterly handbook explains parental leave, vacation days and remote work policy.';
      const [doc] = await db
        .insert(documents)
        .values({
          userId,
          filename: 'handbook.txt',
          mimeType: 'text/plain',
          sizeBytes: text.length,
          status: 'ready',
          embeddingModel: MODEL,
        })
        .returning();
      const embedding = (await createWordEmbedder().embedDocuments([text]))[0]!;
      await db.insert(chunks).values({
        documentId: doc!.id,
        userId,
        ordinal: 0,
        content: text,
        tokenCount: 20,
        embedding,
      });
    }

    it('answers a question about the handbook from the handbook', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);
      await addNote(session.userId);

      const { sources } = await ask(
        ctx,
        session,
        'What does the handbook say about parental leave and vacation?',
      );

      expect(sources[0]).toMatchObject({ filename: 'handbook.txt' });
      expect(sources[0]).not.toHaveProperty('code');
    });

    it('answers a question about the code from the code', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await importShop(ctx, session.agent);
      await addNote(session.userId);

      const { sources } = await ask(ctx, session, 'Where is the login handler implemented?');

      expect(fileAmong(sources, 'src/auth/login.ts')).toBeDefined();
    });

    it('uses the original prompt when only documents are found', async () => {
      const ctx = setup();
      const session = await signedIn(ctx.app);
      await addNote(session.userId);

      await ask(ctx, session, 'What does the handbook say about parental leave and vacation?');

      expect(streamedPromptText(ctx.model, 'system')).toBe(SYSTEM_PROMPT);
    });
  });

  it('has the order functions in the fixture where the ranges say', () => {
    const { content, ranges } = orderServiceFile();
    const lines = content.split('\n');

    expect(lines[ranges['calculateOrderTotal']!.start - 1]).toBe(
      'export async function calculateOrderTotal(arg) {',
    );
    expect(lines[ranges['calculateOrderTotal']!.end - 1]).toBe('}');
  });
});
