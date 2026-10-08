import { count, eq } from 'drizzle-orm';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { chunks, documents, users } from '../../src/db/schema.js';
import {
  ensureEvalCorpus,
  EVAL_USER_EMAIL,
  listSampleFiles,
  removeEvalUser,
} from '../../src/eval/corpus.js';
import { loadGoldenSet } from '../../src/eval/golden.js';
import { createRetrievalSearcher, evaluateRetrieval } from '../../src/eval/retrieval-eval.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

const root = join(import.meta.dirname, '../../../..');
const samplesDir = join(root, 'samples');
const logger = pino({ level: 'silent' });

describe('retrieval evaluation against a database', () => {
  const db = useTestDb();

  function smallCorpus(files: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'samples-'));
    for (const file of files) cpSync(join(samplesDir, file), join(dir, file));
    return dir;
  }

  const embedder = () => createFakeEmbedder();

  describe('the corpus', () => {
    it('lists the documents the app accepts and leaves out the notes and licenses', () => {
      expect(listSampleFiles(samplesDir)).toEqual([
        'nist-ai-rmf-1.0.pdf',
        'rfc6749-oauth2.txt',
        'rfc8259-json.txt',
        'rust-book-generics.md',
        'rust-book-ownership.md',
      ]);
    });

    it('is indexed for a user of its own that nobody can sign in as', async () => {
      const dir = smallCorpus(['rfc8259-json.txt', 'rust-book-generics.md']);

      const result = await ensureEvalCorpus({ db, embedder: embedder(), logger, samplesDir: dir });

      expect(result.indexed.sort()).toEqual(['rfc8259-json.txt', 'rust-book-generics.md']);
      expect(result.failed).toEqual([]);
      const [user] = await db.select().from(users).where(eq(users.email, EVAL_USER_EMAIL));
      expect(user!.id).toBe(result.userId);
      const ready = await db.select().from(documents).where(eq(documents.userId, result.userId));
      expect(ready.map((d) => d.status)).toEqual(['ready', 'ready']);
      const [stored] = await db.select({ total: count() }).from(chunks);
      expect(stored!.total).toBeGreaterThan(20);
    });

    it('is not indexed twice: a second run reuses what is ready', async () => {
      const dir = smallCorpus(['rfc8259-json.txt']);
      const first = embedder();
      await ensureEvalCorpus({ db, embedder: first, logger, samplesDir: dir });
      const second = embedder();

      const result = await ensureEvalCorpus({ db, embedder: second, logger, samplesDir: dir });

      expect(result.reused).toEqual(['rfc8259-json.txt']);
      expect(result.indexed).toEqual([]);
      expect(second.documentCalls).toHaveLength(0);
    });

    it('is indexed again when a file changed or when asked to', async () => {
      const dir = smallCorpus(['rfc8259-json.txt']);
      await ensureEvalCorpus({ db, embedder: embedder(), logger, samplesDir: dir });
      writeFileSync(
        join(dir, 'rfc8259-json.txt'),
        'A different, much shorter document about JSON.',
      );

      const changed = await ensureEvalCorpus({ db, embedder: embedder(), logger, samplesDir: dir });
      const forced = await ensureEvalCorpus({
        db,
        embedder: embedder(),
        logger,
        samplesDir: dir,
        reindex: true,
      });

      expect(changed.indexed).toEqual(['rfc8259-json.txt']);
      expect(forced.indexed).toEqual(['rfc8259-json.txt']);
      expect(await db.select().from(documents)).toHaveLength(1);
    });

    it('reports a document that could not be indexed instead of throwing, after trying a few times', async () => {
      const dir = smallCorpus(['rfc8259-json.txt']);
      const broken = embedder();
      broken.embedDocuments = async () => {
        throw new Error('quota');
      };
      const retries: number[] = [];

      const result = await ensureEvalCorpus({
        db,
        embedder: broken,
        logger,
        samplesDir: dir,
        retryDelayMs: 0,
        onRetry: (_file, attempt) => retries.push(attempt),
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.filename).toBe('rfc8259-json.txt');
      expect(result.indexed).toEqual([]);
      expect(retries).toEqual([1, 2]);
      expect(await db.select().from(documents)).toHaveLength(0);
    });

    it('gets a document indexed on a later attempt when the quota allows it again', async () => {
      const dir = smallCorpus(['rfc8259-json.txt']);
      const flaky = embedder();
      const original = flaky.embedDocuments.bind(flaky);
      let calls = 0;
      flaky.embedDocuments = async (texts, options) => {
        if (++calls === 1) throw new Error('quota');
        return original(texts, options);
      };

      const result = await ensureEvalCorpus({
        db,
        embedder: flaky,
        logger,
        samplesDir: dir,
        retryDelayMs: 0,
      });

      expect(result.indexed).toEqual(['rfc8259-json.txt']);
      expect(result.failed).toEqual([]);
      expect(await db.select().from(documents)).toHaveLength(1);
    });

    it('is removed completely with its user', async () => {
      const dir = smallCorpus(['rfc8259-json.txt']);
      await ensureEvalCorpus({ db, embedder: embedder(), logger, samplesDir: dir });

      expect(await removeEvalUser(db)).toBe(true);
      expect(await removeEvalUser(db)).toBe(false);

      expect(await db.select().from(documents)).toHaveLength(0);
      expect(await db.select().from(chunks)).toHaveLength(0);
    });
  });

  describe('the evaluation of the whole golden set', () => {
    async function run(rewrite = true) {
      const fake = embedder();
      const corpus = await ensureEvalCorpus({ db, embedder: fake, logger, samplesDir });
      const rewriter = {
        rewrite: vi.fn(async (_history: unknown, question: string) => ({
          query: `${question} rewritten`,
          rewritten: true,
        })),
      };
      const searcher = createRetrievalSearcher({
        userId: corpus.userId,
        store: createRetrievalStore(db),
        embedder: fake,
        rewriter,
        logger,
        queryPacingMs: 0,
      });
      const golden = loadGoldenSet(join(root, 'scripts/eval/golden.json'));
      const report = await evaluateRetrieval({ golden, searcher, rewrite });
      return { report, rewriter, fake, golden };
    }

    it('produces a rank or a miss for every question and variant, and a score for every refusal', async () => {
      const { report, golden } = await run();

      const answerable = golden.questions.filter((q) => q.type === 'answerable');
      expect(report.rows).toHaveLength(answerable.length);
      expect(report.unanswerable).toHaveLength(golden.questions.length - answerable.length);
      for (const row of report.rows) {
        for (const rank of Object.values(row.ranks)) {
          expect(rank === null || (rank >= 1 && rank <= report.cutoff)).toBe(true);
        }
        expect(row.hybridTop.length).toBeLessThanOrEqual(report.cutoff);
      }
    }, 60_000);

    it('finds most answers by keyword alone, which does not depend on the embedding model', async () => {
      const { report } = await run(false);

      expect(report.summary.standalone.keyword.hitAt[6]).toBeGreaterThan(0.6);
      expect(report.summary.standalone.keyword.mrr).toBeGreaterThan(0.4);
    }, 60_000);

    it('asks the rewriter for the follow-ups only, and not at all when told not to', async () => {
      const withRewrite = await run(true);
      const without = await run(false);

      expect(withRewrite.rewriter.rewrite).toHaveBeenCalledTimes(5);
      expect(without.rewriter.rewrite).not.toHaveBeenCalled();
    }, 60_000);

    it('embeds each query once, although three variants use it', async () => {
      const { fake, report } = await run(false);

      const queries = new Set(fake.queryCalls);
      expect(fake.queryCalls.length).toBe(queries.size);
      expect(queries.size).toBe(report.rows.length + report.unanswerable.length);
    }, 60_000);
  });
});
