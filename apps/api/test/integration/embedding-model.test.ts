import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import { detectFileType } from '../../src/documents/file-types.js';
import { createIngestionService } from '../../src/documents/ingest.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { ensureEvalCorpus } from '../../src/eval/corpus.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

const logger = pino({ level: 'silent' });

describe('the embedding model recorded per document', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function indexText(userId: string, text: string, embeddingModel?: string) {
    const ingestion = createIngestionService({
      repository,
      embedder: createFakeEmbedder(),
      embeddingModel,
      logger,
    });
    const type = detectFileType('notes.txt')!;
    const document = await repository.create({
      userId,
      filename: 'notes.txt',
      mimeType: type.mimeType,
      sizeBytes: text.length,
    });
    ingestion.enqueue({ document, type, content: Buffer.from(text) });
    await ingestion.idle();
    return document.id;
  }

  const modelOf = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!.embeddingModel;

  it('is stored when a document finishes indexing', async () => {
    const user = await createUser('ada@example.com');

    const id = await indexText(user.id, 'Hybrid retrieval fuses two rankings.', 'model-a');

    expect(await modelOf(id)).toBe('model-a');
  });

  it('counts only ready documents indexed with some other model', async () => {
    const user = await createUser('ada@example.com');
    await indexText(user.id, 'First note about retrieval.', 'model-a');
    await indexText(user.id, 'Second note about retrieval.', 'model-b');
    await repository.create({
      userId: user.id,
      filename: 'pending.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
    });

    expect(await repository.countIndexedWithOtherModel('model-a')).toBe(1);
    expect(await repository.countIndexedWithOtherModel('model-b')).toBe(1);
    expect(await repository.countIndexedWithOtherModel('model-c')).toBe(2);
  });

  describe('when searching', () => {
    async function seed() {
      const user = await createUser('ada@example.com');
      const old = await indexText(user.id, 'Quarterly revenue grew strongly.', 'old-model');
      const current = await indexText(user.id, 'Quarterly revenue grew modestly.', 'new-model');
      return { user, old, current };
    }

    it('vector search ignores documents indexed with another model', async () => {
      const { user, current } = await seed();
      const store = createRetrievalStore(db, { embeddingModel: 'new-model' });

      const found = await store.vectorSearch(user.id, fakeVector('revenue'), 10);

      expect(found.map((c) => c.documentId)).toEqual([current]);
    });

    it('keyword search ignores them too', async () => {
      const { user, current } = await seed();
      const store = createRetrievalStore(db, { embeddingModel: 'new-model' });

      const found = await store.keywordSearch(user.id, 'quarterly revenue', 10);

      expect(found.map((c) => c.documentId)).toEqual([current]);
    });

    it('searches every document when no model is given', async () => {
      const { user } = await seed();

      const found = await createRetrievalStore(db).keywordSearch(user.id, 'quarterly revenue', 10);

      expect(found).toHaveLength(2);
    });

    it('finds nothing when no document was indexed with the configured model', async () => {
      const { user } = await seed();

      const none = await createRetrievalStore(db, { embeddingModel: 'other' }).vectorSearch(
        user.id,
        new Array<number>(EMBEDDING_DIMENSIONS).fill(0.1),
        10,
      );

      expect(none).toEqual([]);
    });
  });

  describe('for the evaluation corpus', () => {
    function corpusDir() {
      const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
      writeFileSync(join(dir, 'rfc8259-json.txt'), 'JSON is a text format. '.repeat(50));
      return dir;
    }

    it('is reused only when it was indexed with the configured model', async () => {
      const samplesDir = corpusDir();
      const base = { db, logger, samplesDir };
      await ensureEvalCorpus({ ...base, embedder: createFakeEmbedder(), embeddingModel: 'a' });

      const same = await ensureEvalCorpus({
        ...base,
        embedder: createFakeEmbedder(),
        embeddingModel: 'a',
      });
      const switched = await ensureEvalCorpus({
        ...base,
        embedder: createFakeEmbedder(),
        embeddingModel: 'b',
      });

      expect(same.reused).toEqual(['rfc8259-json.txt']);
      expect(switched.indexed).toEqual(['rfc8259-json.txt']);
      const rows = await db.select().from(documents);
      expect(rows.map((d) => d.embeddingModel)).toEqual(['b']);
    });
  });
});
