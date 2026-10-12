import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createMeetingIngestion, type MeetingIngestionOptions } from '../../src/meetings/ingest.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const standup = [
  '[00:00:05] Alice: Morning everyone. Let us start with the release plan.',
  '[00:00:20] Bob: The build is green and QA has signed off.',
  '[00:01:10] Carol: I will update the changelog today.',
  '[00:02:00] Alice: Good. Then we ship on Friday.',
].join('\n');

type Setup = Partial<Omit<MeetingIngestionOptions, 'repository' | 'embedder'>>;

describe('meeting ingestion', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(options: { embedder?: Embedder } & Setup = {}) {
    const { embedder = createFakeEmbedder(), ...rest } = options;
    const ingestion = createMeetingIngestion({
      repository,
      embedder,
      logger: pino({ level: 'silent' }),
      embeddingModel: 'fake-model',
      ...rest,
    });
    const app = buildTestApp(db, { meetingIngestion: ingestion });
    return { app, ingestion, embedder };
  }

  async function upload(
    app: ReturnType<typeof buildTestApp>,
    content: string,
    fields: { title?: string; heldOn?: string } = {},
    name = 'standup.txt',
  ) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send(credentials);
    const call = agent.post('/meetings');
    for (const [key, value] of Object.entries(fields)) call.field(key, value);
    const res = await call.attach('file', Buffer.from(content), name);
    return { agent, res, id: res.body.document?.id as string };
  }

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);

  it('turns an uploaded transcript into a ready meeting', async () => {
    const { app, ingestion } = setup();

    const { id } = await upload(app, standup, { heldOn: '2026-10-01' });
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      kind: 'transcript',
      filename: 'standup',
      status: 'ready',
      error: null,
      embeddingModel: 'fake-model',
      participants: ['Alice', 'Bob', 'Carol'],
      durationMs: 115_000,
      meetingHeldOn: '2026-10-01',
      pageCount: null,
      progressPhase: null,
      progressDone: null,
      progressTotal: null,
    });
  });

  it('stores the passages with their time range and speakers, and no code location', async () => {
    const { app, ingestion } = setup();

    const { id } = await upload(app, standup, { heldOn: '2026-10-01' });
    await ingestion.idle();

    const rows = await chunkRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ordinal: 0,
      page: null,
      path: null,
      language: null,
      startLine: null,
      endLine: null,
      symbol: null,
      startMs: 5000,
      endMs: 120_000,
      speakers: ['Alice', 'Bob', 'Carol'],
    });
    expect(rows[0]?.content).toBe(
      [
        'Meeting: standup (2026-10-01)',
        '[00:00:05] Alice: Morning everyone. Let us start with the release plan.',
        '[00:00:20] Bob: The build is green and QA has signed off.',
        '[00:01:10] Carol: I will update the changelog today.',
        '[00:02:00] Alice: Good. Then we ship on Friday.',
      ].join('\n'),
    );
  });

  it('ends the last passage where a WebVTT meeting ends, not where its last cue starts', async () => {
    const { app, ingestion } = setup();
    const vtt = [
      'WEBVTT',
      '',
      '00:00:10.000 --> 00:00:14.000',
      '<v Alice>Hello.</v>',
      '',
      '00:01:00.000 --> 00:01:30.000',
      '<v Bob>Hi there.</v>',
    ].join('\n');

    const { id } = await upload(app, vtt, {}, 'sync.vtt');
    await ingestion.idle();

    const [row] = await chunkRows(id);
    expect(row).toMatchObject({ startMs: 10_000, endMs: 90_000 });
    expect(await documentRow(id)).toMatchObject({
      durationMs: 80_000,
      participants: ['Alice', 'Bob'],
    });
  });

  describe('meeting notes', () => {
    const notes = {
      summary: 'The team planned the release.',
      topics: ['Release'],
      decisions: [{ text: 'Ship on Friday.', startMs: 120_000, evidence: 'we ship on Friday' }],
      actionItems: [
        {
          task: 'Update the changelog.',
          owner: 'Carol',
          due: 'today',
          startMs: 70_000,
          evidence: 'I will update the changelog today',
        },
      ],
      openQuestions: [],
    };

    it('are stored with the meeting and shown to its owner', async () => {
      const { app, ingestion } = setup({ notes: { extract: async () => notes } });

      const { agent, id } = await upload(app, standup);
      await ingestion.idle();

      expect((await documentRow(id)).notes).toEqual(notes);
      const res = await agent.get(`/documents/${id}`);
      expect(res.body.document).toMatchObject({ status: 'ready', notes });
    });

    it('are asked for with the title, the date and every turn', async () => {
      const received: unknown[] = [];
      const { app, ingestion } = setup({
        notes: {
          extract: async (input) => {
            received.push(input);
            return null;
          },
        },
      });

      await upload(app, standup, { title: 'Release sync', heldOn: '2026-10-01' });
      await ingestion.idle();

      expect(received).toEqual([
        {
          title: 'Release sync',
          heldOn: '2026-10-01',
          turns: [
            {
              speaker: 'Alice',
              startMs: 5000,
              text: 'Morning everyone. Let us start with the release plan.',
            },
            { speaker: 'Bob', startMs: 20_000, text: 'The build is green and QA has signed off.' },
            { speaker: 'Carol', startMs: 70_000, text: 'I will update the changelog today.' },
            { speaker: 'Alice', startMs: 120_000, text: 'Good. Then we ship on Friday.' },
          ],
        },
      ]);
    });

    it('are indexed as passages of their own, after those of the transcript', async () => {
      const embedder = createFakeEmbedder();
      const { app, ingestion } = setup({ embedder, notes: { extract: async () => notes } });

      const { id } = await upload(app, standup, { heldOn: '2026-10-01' });
      await ingestion.idle();

      const rows = await chunkRows(id);
      expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
      expect(rows[0]).toMatchObject({ startMs: 5000, endMs: 120_000 });
      expect(rows[1]).toMatchObject({
        page: null,
        path: null,
        startMs: null,
        endMs: null,
        speakers: ['Alice', 'Bob', 'Carol'],
      });
      expect(rows[1]?.content).toContain('Meeting notes: standup (2026-10-01)');
      expect(rows[1]?.content).toContain('- [00:02:00] Ship on Friday.');
      expect(rows[1]?.content).toContain(
        '- [00:01:10] Update the changelog. (owner: Carol, due: today)',
      );
      expect(embedder.documentCalls.flat()).toEqual(rows.map((r) => r.content));
    });

    it('count towards the passages shown while embedding', async () => {
      const seen: Array<number | null> = [];
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          seen.push((await db.select().from(documents))[0]!.progressTotal);
        },
      });
      const { app, ingestion } = setup({ embedder, notes: { extract: async () => notes } });

      const { id } = await upload(app, standup);
      await ingestion.idle();

      expect(seen).toEqual([2]);
      expect((await documentRow(id)).status).toBe('ready');
    });

    it('add no passage when the model found nothing to note', async () => {
      const blank = { summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] };
      const { app, ingestion } = setup({ notes: { extract: async () => blank } });

      const { id } = await upload(app, standup);
      await ingestion.idle();

      expect(await chunkRows(id)).toHaveLength(1);
      expect((await documentRow(id)).notes).toEqual(blank);
    });

    it('can be missing: the meeting is still ready and searchable', async () => {
      const { app, ingestion } = setup({ notes: { extract: async () => null } });

      const { id } = await upload(app, standup);
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({ status: 'ready', error: null, notes: null });
      expect(await chunkRows(id)).toHaveLength(1);
    });

    it('are written before the passages are embedded, and show as a step of their own', async () => {
      const steps: Array<string | null> = [];
      const phase = async () => (await db.select().from(documents))[0]!.progressPhase;
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => void steps.push(await phase()),
      });
      const { app, ingestion } = setup({
        embedder,
        notes: {
          extract: async () => {
            steps.push(await phase());
            return null;
          },
        },
      });

      await upload(app, standup);
      await ingestion.idle();

      expect(steps).toEqual(['analyzing', 'embedding']);
    });

    it('are left out when no model is configured', async () => {
      const { app, ingestion } = setup();

      const { id } = await upload(app, standup);
      await ingestion.idle();

      expect((await documentRow(id)).notes).toBeNull();
    });
  });

  it('names the meeting after the given title', async () => {
    const { app, ingestion } = setup();

    const { id } = await upload(app, standup, { title: 'Release sync' });
    await ingestion.idle();

    expect((await chunkRows(id))[0]?.content.split('\n')[0]).toBe('Meeting: Release sync');
  });

  it('splits a longer meeting into numbered passages that each know who spoke', async () => {
    const { app, ingestion } = setup({ chunkOptions: { maxTokens: 40 } });

    const { id } = await upload(app, standup);
    await ingestion.idle();

    const rows = await chunkRows(id);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i));
    for (const row of rows) {
      expect(row.speakers?.length).toBeGreaterThan(0);
      expect(row.startMs).toBeLessThanOrEqual(row.endMs!);
    }
    expect(rows.map((r) => r.startMs)).toEqual(
      [...rows.map((r) => r.startMs)].sort((a, b) => a! - b!),
    );
  });

  it('embeds the passage exactly as it is stored', async () => {
    const embedder = createFakeEmbedder();
    const { app, ingestion } = setup({ embedder });

    const { id } = await upload(app, standup);
    await ingestion.idle();

    expect(embedder.documentCalls.flat()).toEqual((await chunkRows(id)).map((r) => r.content));
    expect(embedder.queryCalls).toEqual([]);
  });

  it('reports progress while it embeds, in steps of one group of passages', async () => {
    const long = Array.from(
      { length: 300 },
      (_, i) =>
        `[00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}] ${i % 2 ? 'Bob' : 'Alice'}: ${'point '.repeat(30)}${i}.`,
    ).join('\n');
    const seen: Array<{ phase: string | null; done: number | null; total: number | null }> = [];
    const embedder = createFakeEmbedder({
      beforeEmbedDocuments: async () => {
        const [row] = await db.select().from(documents);
        seen.push({
          phase: row!.progressPhase,
          done: row!.progressDone,
          total: row!.progressTotal,
        });
      },
    });
    const { app, ingestion } = setup({ embedder, chunkOptions: { maxTokens: 120 } });

    const { id } = await upload(app, long);
    await ingestion.idle();

    const total = (await chunkRows(id)).length;
    expect(total).toBeGreaterThan(100);
    expect(seen).toEqual(
      Array.from({ length: Math.ceil(total / 100) }, (_, i) => ({
        phase: 'embedding',
        done: i * 100,
        total,
      })),
    );
  });

  it('shows the meeting to its owner while it is processing, with who spoke', async () => {
    const session: { agent?: ReturnType<typeof request.agent> } = {};
    let midway: unknown;
    const embedder = createFakeEmbedder({
      beforeEmbedDocuments: async () => {
        midway = (await session.agent!.get('/documents')).body.documents[0];
      },
    });
    const { app, ingestion } = setup({ embedder });

    const result = await upload(app, standup);
    session.agent = result.agent;
    await ingestion.idle();

    expect(midway).toMatchObject({
      kind: 'transcript',
      status: 'processing',
      participants: ['Alice', 'Bob', 'Carol'],
      progress: { phase: 'embedding' },
    });
    const done = (await result.agent.get(`/documents/${result.id}`)).body.document;
    expect(done).toMatchObject({ status: 'ready', progress: null, chunkCount: 1 });
  });

  it('serves the passage back with its time and speakers', async () => {
    const { app, ingestion } = setup();

    const { agent, id } = await upload(app, standup);
    await ingestion.idle();

    const res = await agent.get(`/documents/${id}/passages?ordinal=0`);
    expect(res.status).toBe(200);
    expect(res.body.passages[0].meeting).toEqual({
      startMs: 5000,
      endMs: 120_000,
      speakers: ['Alice', 'Bob', 'Carol'],
    });
  });

  it('fails with the reason when the passages cannot be embedded, and stores nothing', async () => {
    const embedder: Embedder = {
      embedDocuments: async () => {
        throw new EmbeddingError('rate_limited');
      },
      embedQuery: async () => [],
    };
    const { app, ingestion } = setup({ embedder });

    const { id } = await upload(app, standup);
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      error: new EmbeddingError('rate_limited').message,
      progressPhase: null,
    });
    expect(await chunkRows(id)).toEqual([]);
  });

  it('hides an unexpected failure behind a fixed message', async () => {
    const embedder: Embedder = {
      embedDocuments: async () => {
        throw new Error('connect ECONNRESET 10.0.0.5:443');
      },
      embedQuery: async () => [],
    };
    const { app, ingestion } = setup({ embedder });

    const { id } = await upload(app, standup);
    await ingestion.idle();

    expect(await documentRow(id)).toMatchObject({
      status: 'failed',
      error: 'Something went wrong while processing the transcript.',
    });
  });

  it('fails a transcript that would need more passages than the limit', async () => {
    const embedder = createFakeEmbedder();
    const { app, ingestion } = setup({ embedder, chunkOptions: { maxTokens: 40 }, maxChunks: 1 });

    const { id } = await upload(app, standup);
    await ingestion.idle();

    const row = await documentRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/too long to index: \d+ passages, the limit is 1/);
    expect(embedder.documentCalls).toEqual([]);
  });

  it('copes with the meeting being deleted while it is processed', async () => {
    const session: { agent?: ReturnType<typeof request.agent>; id?: string } = {};
    const embedder = createFakeEmbedder({
      beforeEmbedDocuments: async () => {
        await session.agent!.delete(`/documents/${session.id}`);
      },
    });
    const { app, ingestion } = setup({ embedder });

    const result = await upload(app, standup);
    session.agent = result.agent;
    session.id = result.id;
    await ingestion.idle();

    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(chunks)).toEqual([]);
  });

  it('indexes several meetings one after another, each for its own owner', async () => {
    const { app, ingestion } = setup();
    const first = await upload(app, standup, {}, 'one.txt');
    const other = request.agent(app);
    await other.post('/auth/register').send({ ...credentials, email: 'bob@example.com' });
    const second = await other.post('/meetings').attach('file', Buffer.from(standup), 'two.txt');

    await ingestion.idle();

    const rows = await db.select().from(documents);
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready']);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(2);
    expect((await chunkRows(first.id)).length).toBe(1);
    expect((await chunkRows(second.body.document.id)).length).toBe(1);
  });
});
