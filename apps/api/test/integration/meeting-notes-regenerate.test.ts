import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createMeetingIngestion } from '../../src/meetings/ingest.js';
import type { NotesExtractor, NotesInput } from '../../src/meetings/notes-extractor.js';
import { createMeetingNotesService } from '../../src/meetings/regenerate.js';
import type { MeetingNotes } from '../../src/meetings/types.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const standup = [
  '[00:00:05] Alice: Morning everyone. Let us start with the release plan.',
  '[00:00:20] Bob: The build is green and QA has signed off.',
  '[00:01:10] Carol: I will update the changelog today.',
  '[00:02:00] Alice: Good. Then we ship on Friday.',
].join('\n');

const first: MeetingNotes = {
  summary: 'First version.',
  topics: [],
  decisions: [{ text: 'Ship on Friday.', startMs: 120_000, evidence: 'we ship on Friday' }],
  actionItems: [],
  openQuestions: [],
};

const second: MeetingNotes = {
  summary: 'Second version.',
  topics: [],
  decisions: [],
  actionItems: [
    { task: 'Update the changelog.', owner: 'Carol', due: null, startMs: 70_000, evidence: 'x' },
  ],
  openQuestions: [],
};

describe('regenerating meeting notes', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(
    options: {
      extractor?: NotesExtractor;
      embedder?: Embedder;
      embeddingModel?: string;
      indexedWith?: NotesExtractor;
      regenerateWith?: Embedder;
    } = {},
  ) {
    const {
      extractor = { extract: async () => second },
      embedder = createFakeEmbedder(),
      embeddingModel = 'fake-model',
      indexedWith = { extract: async () => first },
      regenerateWith = embedder,
    } = options;
    const ingestion = createMeetingIngestion({
      repository,
      embedder,
      logger: pino({ level: 'silent' }),
      embeddingModel: 'fake-model',
      notes: indexedWith,
    });
    const meetingNotes = createMeetingNotesService({
      repository,
      embedder: regenerateWith,
      extractor,
      embeddingModel,
    });
    const app = buildTestApp(db, { meetingIngestion: ingestion, meetingNotes });
    return { app, ingestion, embedder };
  }

  async function signedIn(app: ReturnType<typeof buildTestApp>, email = credentials.email) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  async function meeting(
    app: ReturnType<typeof buildTestApp>,
    ingestion: { idle(): Promise<void> },
    email?: string,
  ) {
    const agent = await signedIn(app, email);
    const res = await agent
      .post('/meetings')
      .field('title', 'Release sync')
      .field('heldOn', '2026-10-01')
      .attach('file', Buffer.from(standup), 'standup.txt');
    await ingestion.idle();
    return { agent, id: res.body.document.id as string };
  }

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);

  it('requires a signed-in user', async () => {
    const { app } = setup();

    const res = await request(app).post('/meetings/00000000-0000-4000-8000-000000000001/notes');

    expect(res.status).toBe(401);
  });

  it('replaces the notes and the passage that carries them, and leaves the transcript alone', async () => {
    const { app, ingestion } = setup();
    const { agent, id } = await meeting(app, ingestion);
    const before = await chunkRows(id);
    expect(before.map((r) => r.startMs !== null)).toEqual([true, false]);

    const res = await agent.post(`/meetings/${id}/notes`);

    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ id, status: 'ready', notes: second, chunkCount: 2 });
    const after = await chunkRows(id);
    expect(after.map((r) => r.ordinal)).toEqual([0, 1]);
    expect(after[0]).toMatchObject({ id: before[0]!.id, content: before[0]!.content });
    expect(after[1]!.id).not.toBe(before[1]!.id);
    expect(after[1]).toMatchObject({ startMs: null, speakers: ['Alice', 'Bob', 'Carol'] });
    expect(after[1]?.content).toContain('Second version.');
    expect(after[1]?.content).not.toContain('First version.');
    expect((await documentRow(id)).notes).toEqual(second);
  });

  it('asks the model for notes about the meeting rebuilt from its passages', async () => {
    const received: NotesInput[] = [];
    const { app, ingestion } = setup({
      extractor: {
        extract: async (input) => {
          received.push(input);
          return second;
        },
      },
    });
    const { agent, id } = await meeting(app, ingestion);

    await agent.post(`/meetings/${id}/notes`);

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

  it('embeds only the new notes passage', async () => {
    const embedder = createFakeEmbedder();
    const { app, ingestion } = setup({ embedder });
    const { agent, id } = await meeting(app, ingestion);
    embedder.documentCalls.length = 0;

    await agent.post(`/meetings/${id}/notes`);

    expect(embedder.documentCalls).toHaveLength(1);
    expect(embedder.documentCalls[0]).toHaveLength(1);
    expect(embedder.documentCalls[0]![0]).toContain('Second version.');
  });

  it('adds notes to a meeting that had none, and does not pile up passages when repeated', async () => {
    const { app, ingestion } = setup({ indexedWith: { extract: async () => null } });
    const { agent, id } = await meeting(app, ingestion);
    expect(await chunkRows(id)).toHaveLength(1);
    expect((await documentRow(id)).notes).toBeNull();

    await agent.post(`/meetings/${id}/notes`);
    await agent.post(`/meetings/${id}/notes`);
    await agent.post(`/meetings/${id}/notes`);

    const rows = await chunkRows(id);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
    expect((await documentRow(id)).notes).toEqual(second);
  });

  it('removes the old passage when the new notes have nothing to say', async () => {
    const blank: MeetingNotes = {
      summary: '',
      topics: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
    };
    const { app, ingestion } = setup({ extractor: { extract: async () => blank } });
    const { agent, id } = await meeting(app, ingestion);

    const res = await agent.post(`/meetings/${id}/notes`);

    expect(res.status).toBe(200);
    expect(await chunkRows(id)).toHaveLength(1);
    expect((await documentRow(id)).notes).toEqual(blank);
  });

  it('keeps the old notes and says so when the model gives none', async () => {
    const { app, ingestion } = setup({ extractor: { extract: async () => null } });
    const { agent, id } = await meeting(app, ingestion);

    const res = await agent.post(`/meetings/${id}/notes`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'ai_busy',
      message: 'The notes could not be generated right now. Try again in a minute.',
    });
    expect((await documentRow(id)).notes).toEqual(first);
    expect((await chunkRows(id))[1]?.content).toContain('First version.');
  });

  it('keeps the old notes and says so when the passages cannot be embedded', async () => {
    const failing: Embedder = {
      embedDocuments: async () => {
        throw new EmbeddingError('rate_limited');
      },
      embedQuery: async () => [],
    };
    const { app, ingestion } = setup({ regenerateWith: failing });
    const { agent, id } = await meeting(app, ingestion);

    const res = await agent.post(`/meetings/${id}/notes`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ai_busy');
    expect((await documentRow(id)).notes).toEqual(first);
    expect((await chunkRows(id))[1]?.content).toContain('First version.');
  });

  it('does not touch the meetings of other people', async () => {
    const { app, ingestion } = setup();
    const mine = await meeting(app, ingestion);
    const theirs = await meeting(app, ingestion, 'bob@example.com');

    await mine.agent.post(`/meetings/${mine.id}/notes`);

    expect((await documentRow(theirs.id)).notes).toEqual(first);
    expect((await chunkRows(theirs.id))[1]?.content).toContain('First version.');
  });

  it('answers 404 for an unknown meeting', async () => {
    const { app } = setup();
    const agent = await signedIn(app);

    const res = await agent.post('/meetings/00000000-0000-4000-8000-000000000001/notes');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('answers 404 for an id that is not an id', async () => {
    const { app } = setup();
    const agent = await signedIn(app);

    expect((await agent.post('/meetings/not-an-id/notes')).status).toBe(404);
  });

  it('answers 404 for a meeting that belongs to someone else', async () => {
    const { app, ingestion } = setup();
    const theirs = await meeting(app, ingestion, 'bob@example.com');
    const mine = await signedIn(app);

    const res = await mine.post(`/meetings/${theirs.id}/notes`);

    expect(res.status).toBe(404);
    expect((await documentRow(theirs.id)).notes).toEqual(first);
  });

  it('answers 404 for a document that is not a meeting', async () => {
    const { app } = setup();
    const agent = await signedIn(app);
    const me = await agent.get('/auth/me');
    const [plain] = await db
      .insert(documents)
      .values({
        userId: me.body.user.id,
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
        status: 'ready',
      })
      .returning();

    const res = await agent.post(`/meetings/${plain!.id}/notes`);

    expect(res.status).toBe(404);
  });

  it('asks the user to wait while the meeting is still being processed', async () => {
    const { app } = setup();
    const agent = await signedIn(app);
    const me = await agent.get('/auth/me');
    const [busy] = await db
      .insert(documents)
      .values({
        userId: me.body.user.id,
        kind: 'transcript',
        filename: 'a',
        mimeType: 'text/plain',
        sizeBytes: 1,
      })
      .returning();

    const res = await agent.post(`/meetings/${busy!.id}/notes`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'conflict',
      message: 'The meeting is still being processed',
    });
  });

  it('refuses a meeting indexed with another embedding model, so vectors are not mixed', async () => {
    const { app, ingestion } = setup({ embeddingModel: 'newer-model' });
    const { agent, id } = await meeting(app, ingestion);

    const res = await agent.post(`/meetings/${id}/notes`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/different embedding model/);
    expect((await documentRow(id)).notes).toEqual(first);
  });
});
