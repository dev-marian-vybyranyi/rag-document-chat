import { count, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import {
  CodeCorpusError,
  ensureCodeEvalCorpus,
  EVAL_CODE_USER_EMAIL,
  findPresentAbsentTerms,
  passagesByPath,
  removeCodeEvalUser,
} from '../../src/eval/code-corpus.js';
import { parseGoldenSet } from '../../src/eval/golden.js';
import { recommendThreshold } from '../../src/eval/metrics.js';
import { QuotaExhaustedError } from '../../src/eval/quota-exhausted.js';
import { REFERENCE_ADDRESS, REFERENCE_REPOSITORY } from '../../src/eval/reference-repository.js';
import {
  createRetrievalSearcher,
  evaluateRetrieval,
  findUncoveredQuotes,
} from '../../src/eval/retrieval-eval.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createPassthroughRewriter } from '../../src/rag/rewrite.js';
import { chunkSourceFile, toEmbeddingText } from '../../src/repositories/chunker.js';
import type { GithubImporter } from '../../src/repositories/github.js';
import type { ImportedFile } from '../../src/repositories/zip.js';
import { createFakeEmbedder, createWordEmbedder } from '../helpers/embedder.js';
import { LOGIN_FILE, orderServiceFile, ROUTES_FILE } from '../helpers/shop-repo.js';
import { useTestDb } from './helpers.js';

const logger = pino({ level: 'silent' });
const { commit } = REFERENCE_REPOSITORY;

const file = (path: string, content: string, language = 'javascript'): ImportedFile => ({
  path,
  language,
  content,
});

function fakeGithub(files: ImportedFile[], commitSha: string = commit) {
  const requested: string[] = [];
  const github: GithubImporter = {
    async importFromUrl(url) {
      requested.push(url);
      return {
        source: {
          owner: 'koajs',
          name: 'koa',
          ref: commit,
          url: 'https://github.com/koajs/koa',
          commitSha,
        },
        repository: { files, skipped: [] },
      };
    },
  };
  return { github, requested };
}

const koaLike = () => [
  file(
    'lib/application.js',
    'module.exports = class Application { listen() { return http.createServer(this.callback()) } }\n',
  ),
  file(
    'lib/response.js',
    'module.exports = { redirect (url) { if (!statuses.redirect[this.status]) this.status = 302 } }\n',
  ),
  file('package.json', '{ "name": "koa", "main": "lib/application.js" }\n', 'json'),
  file('History.md', '# 1.0.0\n\n- first release\n', 'markdown'),
  file('__tests__/application/listen.test.js', 'it("listens", () => {})\n'),
  file('test-helpers/context.js', 'module.exports = () => ({})\n'),
  file('docs/faq.md', '# FAQ\n\nWhy?\n', 'markdown'),
];

describe('the code evaluation against a database', () => {
  const db = useTestDb();

  const setup = (files = koaLike(), embedder: Embedder = createFakeEmbedder()) => {
    const github = fakeGithub(files);
    const run = (options: { reindex?: boolean; embeddingModel?: string; attempts?: number } = {}) =>
      ensureCodeEvalCorpus({
        db,
        embedder,
        logger,
        github: github.github,
        retryDelayMs: 0,
        ...options,
      });
    return { run, ...github };
  };

  describe('the corpus', () => {
    it('is the reference repository at its commit, for a user of its own that nobody can sign in as', async () => {
      const { run, requested } = setup();

      const result = await run();

      expect(requested).toEqual([REFERENCE_ADDRESS]);
      expect(result.reused).toBe(false);
      const [user] = await db.select().from(users).where(eq(users.email, EVAL_CODE_USER_EMAIL));
      expect(user!.id).toBe(result.userId);
      const [doc] = await db.select().from(documents).where(eq(documents.id, result.documentId));
      expect(doc).toMatchObject({
        kind: 'repository',
        filename: 'koajs/koa',
        status: 'ready',
        commitSha: commit,
      });
    });

    it('keeps only the files the questions are about', async () => {
      const { run } = setup();

      const { userId } = await run();

      const paths = [...(await passagesByPath(db, userId)).keys()].sort();
      expect(paths).toEqual([
        'REPOSITORY_OVERVIEW',
        'lib/application.js',
        'lib/response.js',
        'package.json',
      ]);
    });

    it('is not downloaded or embedded twice: a second run reuses the copy', async () => {
      const first = setup();
      await first.run();
      const second = setup(koaLike(), createFakeEmbedder());

      const result = await second.run();

      expect(result.reused).toBe(true);
      expect(second.requested).toEqual([]);
      const [stored] = await db.select({ total: count() }).from(documents);
      expect(stored!.total).toBe(1);
    });

    it('is indexed again on request, replacing the old copy', async () => {
      const { run } = setup();
      const before = await run();

      const after = await run({ reindex: true });

      expect(after.reused).toBe(false);
      expect(after.documentId).not.toBe(before.documentId);
      const [stored] = await db.select({ total: count() }).from(documents);
      expect(stored!.total).toBe(1);
    });

    it('is indexed again when it was made with another embedding model', async () => {
      const { run } = setup();
      await run({ embeddingModel: 'old-model' });

      const result = await run({ embeddingModel: 'new-model' });

      expect(result.reused).toBe(false);
    });

    it('is refused when GitHub answers with another commit, and nothing is kept', async () => {
      const { github } = fakeGithub(koaLike(), 'f'.repeat(40));

      await expect(
        ensureCodeEvalCorpus({ db, embedder: createFakeEmbedder(), logger, github }),
      ).rejects.toThrow(
        new CodeCorpusError(`GitHub returned commit ${'f'.repeat(40)} instead of ${commit}`),
      );
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('reports the reason when it cannot be indexed, after trying again', async () => {
      let calls = 0;
      const embedder: Embedder = {
        embedDocuments: async () => {
          calls += 1;
          throw new EmbeddingError('unavailable');
        },
        embedQuery: async () => [],
      };
      const { run } = setup(koaLike(), embedder);

      await expect(run({ attempts: 2 })).rejects.toThrow(CodeCorpusError);
      expect(calls).toBe(2);
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('stops at once when the embedding quota is used up', async () => {
      let calls = 0;
      const embedder: Embedder = {
        embedDocuments: async () => {
          calls += 1;
          throw new EmbeddingError('quota_exhausted');
        },
        embedQuery: async () => [],
      };
      const { run } = setup(koaLike(), embedder);

      await expect(run({ attempts: 3 })).rejects.toThrow(QuotaExhaustedError);
      expect(calls).toBe(1);
    });

    it('can be removed together with its user', async () => {
      const { run } = setup();
      await run();

      expect(await removeCodeEvalUser(db)).toBe(true);

      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select({ total: count() }).from(chunks)).toEqual([{ total: 0 }]);
      expect(await removeCodeEvalUser(db)).toBe(false);
    });
  });

  describe('the checks on the question set', () => {
    const golden = parseGoldenSet({
      version: 1,
      description: 'd',
      questions: [
        {
          id: 'listen',
          type: 'answerable',
          question: 'How does the app start a server?',
          expected: [{ file: 'lib/application.js', quote: 'http.createServer(this.callback())' }],
          answer: 'a',
        },
        {
          id: 'cut-quote',
          type: 'answerable',
          question: 'What is this?',
          expected: [{ file: 'lib/application.js', quote: 'a sentence that is nowhere in it' }],
          answer: 'a',
        },
        {
          id: 'no-sockets',
          type: 'unanswerable',
          question: 'How do sockets work?',
          note: 'n',
          absentTerms: ['websocket'],
        },
        {
          id: 'wrongly-unanswerable',
          type: 'unanswerable',
          question: 'What is redirect?',
          note: 'n',
          absentTerms: ['redirect'],
        },
      ],
    });

    it('find a quote that is not whole inside a passage and a topic that is not absent', async () => {
      const { run } = setup();
      const { userId } = await run();
      const passages = await passagesByPath(db, userId);

      expect(findUncoveredQuotes(golden, passages).map((u) => u.id)).toEqual(['cut-quote']);
      expect(findPresentAbsentTerms(golden, passages)).toEqual([
        { id: 'wrongly-unanswerable', term: 'redirect', path: 'lib/response.js' },
      ]);
    });
  });

  describe('scoring over the shop repository', () => {
    const shopFiles = () => [
      file('src/auth/login.ts', LOGIN_FILE, 'typescript'),
      file('src/routes.ts', ROUTES_FILE, 'typescript'),
      file('src/orders/service.ts', orderServiceFile().content, 'typescript'),
    ];

    async function evaluate(questions: object[]) {
      const embedder = createWordEmbedder();
      const store = createRetrievalStore(db);
      const [user] = await db
        .insert(users)
        .values({ email: 'shop-eval@example.com', passwordHash: 'x' })
        .returning();
      const [doc] = await db
        .insert(documents)
        .values({
          userId: user!.id,
          kind: 'repository',
          filename: 'acme/shop',
          mimeType: 'x',
          sizeBytes: 0,
          status: 'ready',
        })
        .returning();
      const all = shopFiles().flatMap((f) => chunkSourceFile(f));
      const vectors = await embedder.embedDocuments(all.map(toEmbeddingText));
      await db.insert(chunks).values(
        all.map((chunk, ordinal) => ({
          documentId: doc!.id,
          userId: user!.id,
          ordinal,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          embedding: vectors[ordinal]!,
          path: chunk.path,
          language: chunk.language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
        })),
      );
      const golden = parseGoldenSet({ version: 1, description: 'd', questions });
      const searcher = createRetrievalSearcher({
        userId: user!.id,
        store,
        embedder,
        rewriter: createPassthroughRewriter(),
        logger,
      });
      return evaluateRetrieval({ golden, searcher, thresholds: [0.05, 0.1, 0.2, 0.3, 0.5, 0.9] });
    }

    const answerable = (id: string, question: string, path: string, quote: string) => ({
      id,
      type: 'answerable',
      question,
      expected: [{ file: path, quote }],
      answer: 'a',
    });

    it('names a passage by its path in the repository and finds it at the right rank', async () => {
      const report = await evaluate([
        answerable(
          'login',
          'Where is the login handler implemented?',
          'src/auth/login.ts',
          "res.cookie('sid', session.token, { httpOnly: true });",
        ),
        answerable(
          'routes',
          'Which routes does the router define for orders?',
          'src/routes.ts',
          "router.get('/orders'",
        ),
        answerable(
          'total',
          'How is the order total calculated with tax and shipping?',
          'src/orders/service.ts',
          'const subtotal = order.items.reduce',
        ),
      ]);

      expect(report.rows.every((row) => row.ranks.hybrid !== null)).toBe(true);
      for (const row of report.rows) {
        expect(row.hybridTop.some((hit) => hit.relevant)).toBe(true);
        expect(row.hybridTop.every((hit) => hit.filename.startsWith('src/'))).toBe(true);
      }
      expect(report.summary.all.hybrid.hitAt[6]).toBe(1);
    });

    it('counts a question as missed when the quote is in another file', async () => {
      const report = await evaluate([
        answerable(
          'wrong-file',
          'Where is the login handler implemented?',
          'src/routes.ts',
          "res.cookie('sid', session.token",
        ),
      ]);

      expect(report.rows[0]!.ranks.hybrid).toBeNull();
    });

    it('sweeps the threshold and finds a value that separates answerable from unanswerable questions', async () => {
      const report = await evaluate([
        answerable(
          'login',
          'Where is the login handler implemented?',
          'src/auth/login.ts',
          "res.cookie('sid', session.token, { httpOnly: true });",
        ),
        answerable(
          'total',
          'How is the order total calculated with tax and shipping?',
          'src/orders/service.ts',
          'const subtotal = order.items.reduce',
        ),
        {
          id: 'cake',
          type: 'unanswerable',
          question: 'Give me a recipe for chocolate cake',
          note: 'n',
          absentTerms: ['chocolate'],
        },
        {
          id: 'weather',
          type: 'unanswerable',
          question: 'What will the weather be tomorrow in Lviv?',
          note: 'n',
          absentTerms: ['weather'],
        },
      ]);

      const best = recommendThreshold(report.thresholds);

      expect(best).toMatchObject({ answered: 1, refused: 1 });
      expect(report.rows.every((row) => (row.bestScore ?? 0) > 0.1)).toBe(true);
      expect(report.unanswerable.every((row) => (row.bestScore ?? 0) < 0.1)).toBe(true);
    });
  });
});
