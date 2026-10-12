import { describe, expect, it } from 'vitest';
import { chunks, documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { useTestDb } from './helpers.js';

const embedding = (axis: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));

type Kind = 'document' | 'repository' | 'transcript';

describe('keyword search over meetings', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addSource(userId: string, kind: Kind, filename: string, contents: string[]) {
    const [doc] = await db
      .insert(documents)
      .values({ userId, kind, filename, mimeType: 'text/plain', sizeBytes: 1, status: 'ready' })
      .returning();
    await db.insert(chunks).values(
      contents.map((content, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        path: kind === 'repository' ? 'src/a.ts' : null,
        startMs: kind === 'transcript' ? ordinal * 60_000 : null,
        endMs: kind === 'transcript' ? ordinal * 60_000 + 59_000 : null,
        speakers: kind === 'transcript' ? ['Alice', 'Bob'] : null,
        content,
        tokenCount: 5,
        embedding: embedding(ordinal),
      })),
    );
    return doc!;
  }

  const search = async (userId: string, query: string, limit = 5) =>
    (await store.keywordSearch(userId, query, limit)).map((r) => r.content);

  const budget =
    'Meeting: Budget review\n[00:01:10] Carol: We agreed to double the marketing budget.';
  const standup = 'Meeting: Standup\n[00:00:05] Alice: The release ships on Friday.';

  it('finds what was said in a meeting, including other forms of the words', async () => {
    const ada = await createUser('ada@example.com');
    await addSource(ada.id, 'transcript', 'Budget review', [budget, standup]);

    expect(await search(ada.id, 'who doubled the budgets')).toEqual([budget]);
  });

  it('finds a meeting by the name of someone who spoke in it', async () => {
    const ada = await createUser('ada@example.com');
    await addSource(ada.id, 'transcript', 'Budget review', [budget, standup]);

    expect(await search(ada.id, 'Carol')).toEqual([budget]);
  });

  it('finds meetings and documents together, ranked by how well they match', async () => {
    const ada = await createUser('ada@example.com');
    await addSource(ada.id, 'document', 'handbook.pdf', [
      'The marketing budget is set each spring.',
    ]);
    await addSource(ada.id, 'transcript', 'Budget review', [budget]);

    const found = await search(ada.id, 'marketing budget');

    expect(found).toHaveLength(2);
    expect(found).toContain(budget);
    expect(found).toContain('The marketing budget is set each spring.');
  });

  it('does not treat a meeting as code', async () => {
    const ada = await createUser('ada@example.com');
    await addSource(ada.id, 'transcript', 'Budget review', [budget]);
    await addSource(ada.id, 'repository', 'acme/shop', ['export const budget = 1;']);

    const results = await store.keywordSearch(ada.id, 'budget', 5);

    expect(results.filter((r) => r.code).map((r) => r.content)).toEqual([
      'export const budget = 1;',
    ]);
    expect(results.filter((r) => !r.code).map((r) => r.content)).toEqual([budget]);
  });

  it('stays within the chosen sources', async () => {
    const ada = await createUser('ada@example.com');
    const one = await addSource(ada.id, 'transcript', 'Budget review', [budget]);
    await addSource(ada.id, 'transcript', 'Standup', [standup, 'Alice and the budget again.']);

    const found = (await store.keywordSearch(ada.id, 'budget', 5, { documentIds: [one.id] })).map(
      (r) => r.content,
    );

    expect(found).toEqual([budget]);
  });

  it('never returns another user’s meeting', async () => {
    const ada = await createUser('ada@example.com');
    const bob = await createUser('bob@example.com');
    await addSource(bob.id, 'transcript', 'Budget review', [budget]);

    expect(await search(ada.id, 'budget')).toEqual([]);
  });
});
