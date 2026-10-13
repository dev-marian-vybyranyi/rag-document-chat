import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import { loadGoldenMeetings } from '../../src/eval/golden-meetings.js';
import {
  ensureMeetingEvalCorpus,
  EVAL_MEETINGS_USER_EMAIL,
  MeetingCorpusError,
  removeMeetingEvalUser,
  storedNotes,
} from '../../src/eval/meeting-corpus.js';
import { createMeetingSearcher, evaluateMeetingRetrieval } from '../../src/eval/meeting-eval.js';
import { scoreNotes, summarizeNotes } from '../../src/eval/notes-eval.js';
import { QuotaExhaustedError } from '../../src/eval/quota-exhausted.js';
import type { NotesExtractor } from '../../src/meetings/notes-extractor.js';
import type { MeetingNotes } from '../../src/meetings/types.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createWordEmbedder } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

const root = join(import.meta.dirname, '../../../..');
const samplesDir = join(root, 'samples/meetings');
const golden = loadGoldenMeetings(join(root, 'scripts/eval/golden-meetings.json'));
const logger = pino({ level: 'silent' });
const MODEL = 'word-bag';

function notesFromTruth(title: string): MeetingNotes {
  const file = golden.meetings.find((m) => m.title === title)!.file;
  const truth = golden.notes.find((n) => n.meeting === file)!;
  return {
    summary: `Notes of ${title}.`,
    topics: [],
    decisions: truth.decisions.map((d) => ({
      text: d.keywords.join(' '),
      startMs: 0,
      evidence: d.quote,
    })),
    actionItems: truth.actionItems.map((a) => ({
      task: a.keywords.join(' '),
      owner: a.owner,
      due: a.due,
      startMs: 0,
      evidence: a.quote,
    })),
    openQuestions: truth.openQuestions.map((q) => q.keywords.join(' ')),
  };
}

const truthful: NotesExtractor = {
  extract: async ({ title }) => notesFromTruth(title),
};

describe('the meeting evaluation', () => {
  const db = useTestDb();
  const temporary: string[] = [];
  afterAll(() => {
    for (const folder of temporary) rmSync(folder, { recursive: true, force: true });
  });

  const options = (overrides: Partial<Parameters<typeof ensureMeetingEvalCorpus>[0]> = {}) => ({
    db,
    embedder: createWordEmbedder(),
    embeddingModel: MODEL,
    logger,
    golden,
    samplesDir,
    retryDelayMs: 0,
    ...overrides,
  });

  describe('indexing the sample meetings', () => {
    it('indexes all three for an evaluation user of their own', async () => {
      const corpus = await ensureMeetingEvalCorpus(options());

      expect(corpus.indexed).toEqual(golden.meetings.map((m) => m.file));
      expect(corpus.reused).toEqual([]);
      expect([...corpus.documents.keys()]).toEqual(golden.meetings.map((m) => m.file));
      const [user] = await db.select().from(users).where(eq(users.email, EVAL_MEETINGS_USER_EMAIL));
      expect(user?.id).toBe(corpus.userId);
      const rows = await db.select().from(documents);
      expect(
        rows.map((r) => [r.filename, r.kind, r.status, r.meetingHeldOn, r.embeddingModel]).sort(),
      ).toEqual([
        ['Hiring sync', 'transcript', 'ready', '2026-10-05', MODEL],
        ['Incident review', 'transcript', 'ready', '2026-09-24', MODEL],
        ['Product planning', 'transcript', 'ready', '2026-09-14', MODEL],
      ]);
      expect(rows.find((r) => r.filename === 'Hiring sync')?.mimeType).toBe('text/vtt');
      expect(rows.find((r) => r.filename === 'Product planning')?.participants).toEqual([
        'Priya',
        'Marcus',
        'Lena',
        'Tomás',
        'Marco',
      ]);
    });

    it('reuses what is already indexed, without embedding anything', async () => {
      await ensureMeetingEvalCorpus(options());
      const embedder = createWordEmbedder();

      const again = await ensureMeetingEvalCorpus(options({ embedder }));

      expect(again.indexed).toEqual([]);
      expect(again.reused).toEqual(golden.meetings.map((m) => m.file));
      expect(embedder.documentCalls).toEqual([]);
      expect(await db.select().from(documents)).toHaveLength(3);
    });

    it('indexes again when asked to, and leaves no copy of the old one behind', async () => {
      const first = await ensureMeetingEvalCorpus(options());
      const embedder = createWordEmbedder();

      const second = await ensureMeetingEvalCorpus(options({ embedder, reindex: true }));

      expect(second.indexed).toHaveLength(3);
      expect(embedder.documentCalls.length).toBeGreaterThan(0);
      expect(await db.select().from(documents)).toHaveLength(3);
      expect(
        [...second.documents.values()].some((id) => [...first.documents.values()].includes(id)),
      ).toBe(false);
    });

    it('indexes again a meeting whose file changed, and only that one', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'meetings-'));
      temporary.push(folder);
      cpSync(samplesDir, folder, { recursive: true });
      const first = await ensureMeetingEvalCorpus(options({ samplesDir: folder }));
      const file = join(folder, 'incident-review.txt');
      writeFileSync(file, `${readFileSync(file, 'utf8')}Gus (00:10:45): One more thing.\n`);

      const second = await ensureMeetingEvalCorpus(options({ samplesDir: folder }));

      expect(second.indexed).toEqual(['incident-review.txt']);
      expect(second.reused).toEqual(['product-planning.txt', 'hiring-sync.vtt']);
      expect(second.documents.get('product-planning.txt')).toBe(
        first.documents.get('product-planning.txt'),
      );
      expect(await db.select().from(documents)).toHaveLength(3);
    });

    it('indexes again after the embedding model changed', async () => {
      await ensureMeetingEvalCorpus(options());

      const again = await ensureMeetingEvalCorpus(options({ embeddingModel: 'another-model' }));

      expect(again.indexed).toHaveLength(3);
      expect(
        (await db.select().from(documents)).every((d) => d.embeddingModel === 'another-model'),
      ).toBe(true);
    });

    it('stores the passages of every meeting with the time and speakers', async () => {
      const corpus = await ensureMeetingEvalCorpus(options());

      const rows = await db
        .select()
        .from(chunks)
        .where(eq(chunks.documentId, corpus.documents.get('incident-review.txt')!));
      expect(rows.length).toBeGreaterThan(2);
      expect(rows.every((r) => r.startMs !== null && r.speakers !== null)).toBe(true);
    });
  });

  describe('failures', () => {
    it('stops when the free quota is used up', async () => {
      const exhausted: Embedder = {
        embedDocuments: async () => {
          throw new EmbeddingError('quota_exhausted');
        },
        embedQuery: async () => [],
      };

      await expect(
        ensureMeetingEvalCorpus(options({ embedder: exhausted })),
      ).rejects.toBeInstanceOf(QuotaExhaustedError);
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('tries again, then says what went wrong, and leaves nothing half-done', async () => {
      let calls = 0;
      const unavailable: Embedder = {
        embedDocuments: async () => {
          calls++;
          throw new EmbeddingError('unavailable');
        },
        embedQuery: async () => [],
      };
      const retries: string[] = [];

      await expect(
        ensureMeetingEvalCorpus(
          options({
            embedder: unavailable,
            attempts: 2,
            onRetry: (what, n) => retries.push(`${what} ${n}`),
          }),
        ),
      ).rejects.toThrow(MeetingCorpusError);
      expect(calls).toBe(2);
      expect(retries).toEqual(['product-planning.txt 1']);
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('recovers when the second try works', async () => {
      const word = createWordEmbedder();
      let failures = 1;
      const flaky: Embedder = {
        embedDocuments: async (texts, opts) => {
          if (failures-- > 0) throw new EmbeddingError('unavailable');
          return word.embedDocuments(texts, opts);
        },
        embedQuery: word.embedQuery,
      };

      const corpus = await ensureMeetingEvalCorpus(options({ embedder: flaky }));

      expect(corpus.indexed).toHaveLength(3);
      expect(await db.select().from(documents)).toHaveLength(3);
    });
  });

  describe('notes', () => {
    it('are written with each meeting when a model is given', async () => {
      const corpus = await ensureMeetingEvalCorpus(options({ notes: truthful }));

      const notes = await storedNotes(db, corpus.userId, golden);
      expect(corpus.withoutNotes).toEqual([]);
      expect([...notes.values()].every((n) => n !== null)).toBe(true);
      const scores = golden.notes.map((truth) => scoreNotes(truth, notes.get(truth.meeting)!));
      expect(summarizeNotes(scores)).toMatchObject({
        decisionRecall: 1,
        actionRecall: 1,
        ownerAccuracy: 1,
        dueAccuracy: 1,
        questionRecall: 1,
      });
    });

    it('are left alone when no model is given', async () => {
      const corpus = await ensureMeetingEvalCorpus(options());

      expect(corpus.withoutNotes).toEqual([]);
      expect([...(await storedNotes(db, corpus.userId, golden)).values()]).toEqual([
        null,
        null,
        null,
      ]);
    });

    it('are asked for again when the model gave none, until it does', async () => {
      const asked: string[] = [];
      let failures = 2;
      const flaky: NotesExtractor = {
        extract: async (input) => {
          asked.push(input.title);
          return failures-- > 0 ? null : notesFromTruth(input.title);
        },
      };

      const corpus = await ensureMeetingEvalCorpus(options({ notes: flaky }));

      expect(corpus.withoutNotes).toEqual([]);
      expect(asked.length).toBeGreaterThan(3);
      expect(
        [...(await storedNotes(db, corpus.userId, golden)).values()].every((n) => n !== null),
      ).toBe(true);
    });

    it('are reported as missing when the model never gives any', async () => {
      const never: NotesExtractor = { extract: async () => null };

      const corpus = await ensureMeetingEvalCorpus(options({ notes: never, attempts: 2 }));

      expect(corpus.withoutNotes).toEqual(golden.meetings.map((m) => m.file));
      expect(corpus.indexed).toHaveLength(3);
    });

    it('are written afterwards for a meeting that was indexed without them', async () => {
      await ensureMeetingEvalCorpus(options());

      const corpus = await ensureMeetingEvalCorpus(options({ notes: truthful }));

      expect(corpus.reused).toHaveLength(3);
      expect(corpus.withoutNotes).toEqual([]);
      expect(
        [...(await storedNotes(db, corpus.userId, golden)).values()].every((n) => n !== null),
      ).toBe(true);
    });
  });

  it('removes the evaluation user with its meetings', async () => {
    await ensureMeetingEvalCorpus(options({ notes: truthful }));

    expect(await removeMeetingEvalUser(db)).toBe(true);

    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(chunks)).toEqual([]);
    expect(await removeMeetingEvalUser(db)).toBe(false);
  });

  describe('asking the golden questions', () => {
    async function run() {
      const embedder = createWordEmbedder();
      const corpus = await ensureMeetingEvalCorpus(options({ embedder, notes: truthful }));
      const searcher = createMeetingSearcher({
        userId: corpus.userId,
        store: createRetrievalStore(db, { embeddingModel: MODEL }),
        embedder,
        logger,
        documents: corpus.documents,
        queryPacingMs: 0,
      });
      return evaluateMeetingRetrieval({ golden, searcher });
    }

    it('asks every question, and the app picks out every speaker and time that a question names', async () => {
      const report = await run();

      expect(report.rows).toHaveLength(46);
      expect(report.unanswerable).toHaveLength(6);
      expect(report.filters.named).toBe(14);
      expect(report.filters.recognised).toBe(14);
      expect(report.filters.unexpected).toBe(0);
      expect(report.filters.relaxed).toBe(0);
    });

    it('finds the right moment in the top six for nearly every question', async () => {
      const report = await run();

      expect(report.summary.all.hybrid.hitAt[6]).toBeGreaterThanOrEqual(0.95);
      expect(report.rows.filter((row) => row.ranks.hybrid === null).length).toBeLessThanOrEqual(2);
    });

    it('shows what the filters are worth: questions about a stretch of time rank the right moment higher with them', async () => {
      const report = await run();

      const time = report.summary.byKind.time;
      expect(time.hybrid.questions).toBe(6);
      expect(time.hybrid.hitAt[1]).toBeGreaterThan(time.unfiltered.hitAt[1]!);
      expect(time.hybrid.mrr).toBeGreaterThan(time.unfiltered.mrr);
    });

    it('gives a score to every question, so the threshold can be swept', async () => {
      const report = await run();

      expect(report.rows.every((row) => row.bestScore !== null)).toBe(true);
      expect(report.unanswerable.every((row) => row.bestScore !== null)).toBe(true);
      expect(report.thresholds.length).toBeGreaterThan(5);
    });

    it('does not leave the meetings of one evaluation user in the way of another user', async () => {
      const corpus = await ensureMeetingEvalCorpus(options());
      await db.insert(users).values({ email: 'ann@example.com', passwordHash: 'x' });
      const [ann] = await db.select().from(users).where(eq(users.email, 'ann@example.com'));
      const store = createRetrievalStore(db, { embeddingModel: MODEL });

      expect(await store.meetingFacts(ann!.id)).toEqual([]);
      expect((await store.meetingFacts(corpus.userId)).length).toBe(3);
    });
  });
});
