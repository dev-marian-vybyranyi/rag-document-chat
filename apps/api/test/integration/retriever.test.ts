import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents, users } from '../../src/db/schema.js';
import { createRetrievalStore, type RetrievalStore } from '../../src/rag/retrieval.js';
import { createRetriever, DEFAULT_LIMIT } from '../../src/rag/retriever.js';
import { createFakeEmbedder, fakeVector } from '../helpers/embedder.js';
import { useTestDb } from './helpers.js';

describe('retriever', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  function setup(options: { embedder?: Embedder; store?: RetrievalStore } = {}) {
    const logLines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => void logLines.push(line) });
    const embedder = options.embedder ?? createFakeEmbedder();
    const retriever = createRetriever({ store: options.store ?? store, embedder, logger });
    return { retriever, embedder, logLines };
  }

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addChunks(
    userId: string,
    rows: Array<{ content: string; embeddingOf?: string }>,
    filename = 'notes.txt',
  ) {
    const [doc] = await db
      .insert(documents)
      .values({ userId, filename, mimeType: 'text/plain', sizeBytes: 1, status: 'ready' })
      .returning();
    await db.insert(chunks).values(
      rows.map((row, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        content: row.content,
        tokenCount: 5,
        embedding: fakeVector(row.embeddingOf ?? row.content),
      })),
    );
    return doc!;
  }

  const contents = (result: { chunks: Array<{ content: string }> }) =>
    result.chunks.map((c) => c.content);

  it('ranks first a chunk that both the vector and the keyword search found', async () => {
    const ada = await createUser('ada@example.com');
    const query = 'graph index for nearest neighbour search';
    await addChunks(ada.id, [
      { content: 'Bread needs flour, water and yeast.' },
      { content: query },
      { content: 'The Eiffel Tower is in Paris.' },
    ]);
    const { retriever } = setup();

    const result = await retriever.retrieve(ada.id, query);

    expect(result.mode).toBe('hybrid');
    expect(result.chunks[0]).toMatchObject({
      content: query,
      vectorRank: 1,
      keywordRank: 1,
    });
    expect(result.chunks[0]!.vectorScore).toBeCloseTo(1, 4);
  });

  it('brings in a chunk that only the vector search finds, and one that only keywords find', async () => {
    const ada = await createUser('ada@example.com');
    await addChunks(ada.id, [
      { content: 'Sourdough starters need feeding.', embeddingOf: 'graph search' },
      { content: 'A graph can be searched breadth first.', embeddingOf: 'unrelated filler' },
      { content: 'Rainfall totals for March.', embeddingOf: 'more filler' },
    ]);
    const { retriever } = setup();

    const result = await retriever.retrieve(ada.id, 'graph search', { candidates: 1 });

    const bySemantics = result.chunks.find((c) => c.content.startsWith('Sourdough'))!;
    const byKeywords = result.chunks.find((c) => c.content.startsWith('A graph'))!;
    expect(bySemantics).toMatchObject({ vectorRank: 1, keywordRank: null });
    expect(byKeywords).toMatchObject({ vectorRank: null, keywordRank: 1 });
    expect(contents(result)).toHaveLength(2);
  });

  it('only ever looks at the asking user’s documents', async () => {
    const ada = await createUser('ada@example.com');
    const grace = await createUser('grace@example.com');
    await addChunks(ada.id, [{ content: 'Ada notes on retrieval.' }]);
    await addChunks(grace.id, [{ content: 'Grace secret on retrieval.' }]);
    const { retriever } = setup();

    const result = await retriever.retrieve(ada.id, 'Grace secret on retrieval.');

    expect(contents(result)).toEqual(['Ada notes on retrieval.']);
  });

  it('returns nothing for a user without documents', async () => {
    const ada = await createUser('ada@example.com');
    const { retriever } = setup();

    expect(await retriever.retrieve(ada.id, 'anything at all')).toEqual({
      chunks: [],
      mode: 'hybrid',
    });
  });

  it('does not call the embedding service for a blank query', async () => {
    const ada = await createUser('ada@example.com');
    const { retriever, embedder } = setup();

    const result = await retriever.retrieve(ada.id, '   ');

    expect(result.chunks).toEqual([]);
    expect((embedder as ReturnType<typeof createFakeEmbedder>).queryCalls).toEqual([]);
  });

  it('returns at most the requested number of chunks, six by default', async () => {
    const ada = await createUser('ada@example.com');
    await addChunks(
      ada.id,
      Array.from({ length: 15 }, (_, i) => ({ content: `Retrieval note number ${i}.` })),
    );
    const { retriever } = setup();

    expect((await retriever.retrieve(ada.id, 'retrieval note')).chunks).toHaveLength(DEFAULT_LIMIT);
    expect((await retriever.retrieve(ada.id, 'retrieval note', { limit: 3 })).chunks).toHaveLength(
      3,
    );
  });

  it('asks each search for the configured number of candidates', async () => {
    const ada = await createUser('ada@example.com');
    const spy: RetrievalStore = {
      vectorSearch: vi.fn(store.vectorSearch),
      keywordSearch: vi.fn(store.keywordSearch),
    };
    const { retriever } = setup({ store: spy });

    await retriever.retrieve(ada.id, 'retrieval', { candidates: 7 });

    expect(spy.vectorSearch).toHaveBeenCalledWith(ada.id, expect.any(Array), 7);
    expect(spy.keywordSearch).toHaveBeenCalledWith(ada.id, 'retrieval', 7);
  });

  describe('when the embedding service fails', () => {
    const failing = (error: Error): Embedder => ({
      embedDocuments: async () => [],
      embedQuery: async () => {
        throw error;
      },
    });

    it('falls back to the keyword search and says so', async () => {
      const ada = await createUser('ada@example.com');
      await addChunks(ada.id, [
        { content: 'Hybrid retrieval combines two rankings.' },
        { content: 'Unrelated text about bread.' },
      ]);
      const { retriever, logLines } = setup({
        embedder: failing(new EmbeddingError('rate_limited')),
      });

      const result = await retriever.retrieve(ada.id, 'hybrid retrieval');

      expect(result.mode).toBe('keyword-only');
      expect(contents(result)).toEqual(['Hybrid retrieval combines two rankings.']);
      expect(result.chunks[0]).toMatchObject({
        vectorRank: null,
        vectorScore: null,
        keywordRank: 1,
      });
      expect(logLines.join('')).toContain('keyword search only');
    });

    it('does not hide bugs: an error that is not an embedding failure still propagates', async () => {
      const ada = await createUser('ada@example.com');
      const { retriever } = setup({
        embedder: failing(new TypeError('undefined is not a function')),
      });

      await expect(retriever.retrieve(ada.id, 'anything')).rejects.toThrow(TypeError);
    });

    it('still reports an empty result when the keywords find nothing either', async () => {
      const ada = await createUser('ada@example.com');
      await addChunks(ada.id, [{ content: 'Bread needs flour.' }]);
      const { retriever } = setup({ embedder: failing(new EmbeddingError('unavailable')) });

      const result = await retriever.retrieve(ada.id, 'quantum chromodynamics');

      expect(result).toEqual({ chunks: [], mode: 'keyword-only' });
    });
  });
});
