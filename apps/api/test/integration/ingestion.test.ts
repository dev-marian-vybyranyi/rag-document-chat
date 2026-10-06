import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents } from '../../src/db/schema.js';
import {
  createIngestionService,
  INTERRUPTED_MESSAGE,
  type IngestionOptions,
} from '../../src/documents/ingest.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { buildPdf } from '../helpers/pdf.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

const sentences = (count: number) =>
  Array.from({ length: count }, (_, i) => `Sentence number ${i} talks about retrieval.`).join(' ');

describe('document ingestion', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function setup(
    options: { embedder?: Embedder } & Partial<
      Omit<IngestionOptions, 'embedder' | 'repository'>
    > = {},
  ) {
    const { embedder = createFakeEmbedder(), ...rest } = options;
    const ingestion = createIngestionService({
      repository,
      embedder,
      logger: pino({ level: 'silent' }),
      ...rest,
    });
    const app = buildTestApp(db, { ingestion });
    return { app, ingestion, embedder };
  }

  async function upload(
    app: ReturnType<typeof buildTestApp>,
    content: Buffer | string,
    filename: string,
    email = credentials.email,
  ) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    const res = await agent
      .post('/documents')
      .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), filename);
    return res.body.document.id as string;
  }

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0];
  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);

  describe('a successful run', () => {
    it('turns an uploaded text file into a ready document with its chunks', async () => {
      const { app, ingestion } = setup();

      const id = await upload(app, 'Embeddings turn text into vectors.', 'notes.txt');
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({
        status: 'ready',
        error: null,
        pageCount: null,
      });
      const rows = await chunkRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ordinal: 0,
        page: null,
        content: 'Embeddings turn text into vectors.',
        tokenCount: 9,
      });
    });

    it('stores the vector the embedder produced for each chunk', async () => {
      const { app, ingestion } = setup();

      const id = await upload(app, 'Embeddings turn text into vectors.', 'notes.txt');
      await ingestion.idle();

      const [row] = await chunkRows(id);
      const expected = fakeVector('Embeddings turn text into vectors.');
      expect(row!.embedding).toHaveLength(expected.length);
      row!.embedding.slice(0, 10).forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 5));
    });

    it('records pages for a PDF, with the page count on the document', async () => {
      const { app, ingestion } = setup();
      const pdf = buildPdf([['First page about embeddings.'], ['Second page about databases.']]);

      const id = await upload(app, pdf, 'paper.pdf');
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({ status: 'ready', pageCount: 2 });
      expect((await chunkRows(id)).map((c) => c.page)).toEqual([1, 2]);
    });

    it('keeps the chunks in reading order across a long document', async () => {
      const { app, ingestion } = setup();

      const id = await upload(app, sentences(300), 'long.txt');
      await ingestion.idle();

      const rows = await chunkRows(id);
      expect(rows.length).toBeGreaterThan(3);
      expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i));
      expect(rows[0]!.content.startsWith('Sentence number 0 ')).toBe(true);
    });

    it('makes the text searchable by keyword', async () => {
      const { app, ingestion } = setup();
      const id = await upload(app, 'Hybrid retrieval combines vectors with keywords.', 'a.txt');
      await ingestion.idle();

      const hits = await db
        .select({ id: chunks.id })
        .from(chunks)
        .where(sql`${chunks.searchVector} @@ plainto_tsquery('english', 'keyword')`);

      expect(hits).toHaveLength(1);
      expect(await chunkRows(id)).toHaveLength(1);
    });

    it('tags every chunk with the owner of the document', async () => {
      const { app, ingestion } = setup();

      const id = await upload(app, 'A note.', 'a.txt');
      await ingestion.idle();

      const doc = await documentRow(id);
      expect((await chunkRows(id)).every((c) => c.userId === doc!.userId)).toBe(true);
    });
  });

  describe('while it runs', () => {
    it('answers the upload straight away and keeps the document "processing" until done', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { app, ingestion } = setup({
        embedder: createFakeEmbedder({ beforeEmbedDocuments: () => gate }),
      });

      const id = await upload(app, 'A note about vectors.', 'a.txt');

      expect((await documentRow(id))?.status).toBe('processing');
      expect(await chunkRows(id)).toEqual([]);

      release();
      await ingestion.idle();

      expect((await documentRow(id))?.status).toBe('ready');
    });

    it('works through uploads one at a time', async () => {
      let active = 0;
      let peak = 0;
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active--;
        },
      });
      const { app, ingestion } = setup({ embedder });

      const ids = [
        await upload(app, 'First note.', 'one.txt', 'one@example.com'),
        await upload(app, 'Second note.', 'two.txt', 'two@example.com'),
        await upload(app, 'Third note.', 'three.txt', 'three@example.com'),
      ];
      await ingestion.idle();

      expect(peak).toBe(1);
      for (const id of ids) expect((await documentRow(id))?.status).toBe('ready');
    });

    it('sends texts to the embedder in groups of at most 100', async () => {
      const embedder = createFakeEmbedder();
      const { app, ingestion } = setup({
        embedder,
        chunkOptions: { maxTokens: 5, overlapTokens: 0 },
      });
      const paragraphs = Array.from({ length: 250 }, (_, i) => `Paragraph ${i}`).join('\n\n');

      const id = await upload(app, paragraphs, 'many.txt');
      await ingestion.idle();

      expect(embedder.documentCalls.map((texts) => texts.length)).toEqual([100, 100, 50]);
      expect(await chunkRows(id)).toHaveLength(250);
    });
  });

  describe('when something goes wrong', () => {
    it('explains that a PDF without text is probably a scan', async () => {
      const { app, ingestion } = setup();

      const id = await upload(app, buildPdf([[], []]), 'scan.pdf');
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({
        status: 'failed',
        error: 'The PDF has no selectable text (it may be a scan)',
      });
      expect(await chunkRows(id)).toEqual([]);
    });

    it('reports an embedding failure with its user-facing message and stores no chunks', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new EmbeddingError('rate_limited');
        },
        embedQuery: async () => [],
      };
      const { app, ingestion } = setup({ embedder });

      const id = await upload(app, sentences(300), 'long.txt');
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({
        status: 'failed',
        error: new EmbeddingError('rate_limited').message,
      });
      expect(await chunkRows(id)).toEqual([]);
    });

    it('leaves no partial chunks when a later group of embeddings fails', async () => {
      let calls = 0;
      const base = createFakeEmbedder();
      const embedder: Embedder = {
        ...base,
        embedDocuments: async (texts) => {
          if (++calls === 2) throw new EmbeddingError('unavailable');
          return base.embedDocuments(texts);
        },
      };
      const { app, ingestion } = setup({
        embedder,
        chunkOptions: { maxTokens: 5, overlapTokens: 0 },
      });

      const id = await upload(
        app,
        Array.from({ length: 250 }, (_, i) => `Paragraph ${i}`).join('\n\n'),
        'many.txt',
      );
      await ingestion.idle();

      expect((await documentRow(id))?.status).toBe('failed');
      expect(await db.select().from(chunks)).toEqual([]);
    });

    it('hides unexpected errors behind a generic message', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new Error('connection string postgres://secret leaked');
        },
        embedQuery: async () => [],
      };
      const { app, ingestion } = setup({ embedder });

      const id = await upload(app, 'A note.', 'a.txt');
      await ingestion.idle();

      const doc = await documentRow(id);
      expect(doc?.status).toBe('failed');
      expect(doc?.error).toBe('Something went wrong while processing the document.');
    });

    it('refuses a document that would produce too many chunks', async () => {
      const { app, ingestion, embedder } = setup({ maxChunks: 3 });

      const id = await upload(app, sentences(300), 'huge.txt');
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({
        status: 'failed',
        error: 'The document is too long to index (limit 3 passages)',
      });
      expect((embedder as ReturnType<typeof createFakeEmbedder>).documentCalls).toEqual([]);
    });

    it('does not mind when the document is deleted while it is being processed', async () => {
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          await db.delete(documents);
        },
      });
      const { app, ingestion } = setup({ embedder });

      await upload(app, 'A note about vectors.', 'a.txt');
      await ingestion.idle();

      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(chunks)).toEqual([]);
    });

    it('keeps working on the next document after one fails', async () => {
      let calls = 0;
      const base = createFakeEmbedder();
      const embedder: Embedder = {
        ...base,
        embedDocuments: async (texts) => {
          if (++calls === 1) throw new EmbeddingError('timeout');
          return base.embedDocuments(texts);
        },
      };
      const { app, ingestion } = setup({ embedder });

      const first = await upload(app, 'First note.', 'one.txt', 'one@example.com');
      const second = await upload(app, 'Second note.', 'two.txt', 'two@example.com');
      await ingestion.idle();

      expect((await documentRow(first))?.status).toBe('failed');
      expect((await documentRow(second))?.status).toBe('ready');
    });
  });

  describe('after a restart', () => {
    it('marks documents that were still processing as failed, and leaves the others alone', async () => {
      const { app, ingestion } = setup();
      const done = await upload(app, 'Done note.', 'done.txt', 'a@example.com');
      await ingestion.idle();
      const [user] = await db.select({ userId: documents.userId }).from(documents);
      const stuck = await repository.create({
        userId: user!.userId,
        filename: 'stuck.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
      });

      const count = await repository.failInterrupted(INTERRUPTED_MESSAGE);

      expect(count).toBe(1);
      expect(await documentRow(stuck.id)).toMatchObject({
        status: 'failed',
        error: INTERRUPTED_MESSAGE,
      });
      expect((await documentRow(done))?.status).toBe('ready');
    });

    it('does nothing when no document is stuck', async () => {
      expect(await repository.failInterrupted(INTERRUPTED_MESSAGE)).toBe(0);
    });
  });
});
