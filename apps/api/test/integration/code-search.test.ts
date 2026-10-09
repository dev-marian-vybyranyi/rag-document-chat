import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { chunks, documents, EMBEDDING_DIMENSIONS, users } from '../../src/db/schema.js';
import { createRetrievalStore } from '../../src/rag/retrieval.js';
import { useTestDb } from './helpers.js';

const embedding = (axis: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));

interface Row {
  content: string;
  path?: string | null;
  symbol?: string | null;
}

describe('keyword search over code', () => {
  const db = useTestDb();
  const store = createRetrievalStore(db);

  async function createUser(email: string) {
    const [user] = await db.insert(users).values({ email, passwordHash: 'hash' }).returning();
    return user!;
  }

  async function addSource(
    userId: string,
    kind: 'document' | 'repository',
    filename: string,
    rows: Row[],
  ) {
    const [doc] = await db
      .insert(documents)
      .values({ userId, kind, filename, mimeType: 'text/plain', sizeBytes: 1, status: 'ready' })
      .returning();
    await db.insert(chunks).values(
      rows.map((row, ordinal) => ({
        documentId: doc!.id,
        userId,
        ordinal,
        path: row.path ?? null,
        symbol: row.symbol ?? null,
        content: row.content,
        tokenCount: 5,
        embedding: embedding(ordinal),
      })),
    );
    return doc!;
  }

  const search = async (userId: string, query: string, limit = 5) =>
    (await store.keywordSearch(userId, query, limit)).map((r) => r.content);

  describe('identifiers', () => {
    async function seed() {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/auth/router.ts', content: 'export function createAuthRouter(deps) {}' },
        { path: 'src/orders/list.ts', content: 'export function listOrders() { return []; }' },
        {
          path: 'src/db/pool.py',
          content: 'def get_connection_pool(settings):\n    return Pool()',
        },
        { path: 'src/http/server.ts', content: 'export class HTTPServerConfig {}' },
        { path: 'src/limits.ts', content: 'export const MAX_LOGIN_ATTEMPTS = 5;' },
        { path: 'src/misc.ts', content: 'export const unrelated = true;' },
      ]);
      return ada;
    }

    it('finds a function by its exact camelCase name', async () => {
      const ada = await seed();

      expect(await search(ada.id, 'createAuthRouter')).toEqual([
        'export function createAuthRouter(deps) {}',
      ]);
    });

    it('finds a function by the words of its name, in any case', async () => {
      const ada = await seed();

      expect(await search(ada.id, 'create auth router')).toContain(
        'export function createAuthRouter(deps) {}',
      );
      expect(await search(ada.id, 'CREATE_AUTH_ROUTER')).toContain(
        'export function createAuthRouter(deps) {}',
      );
    });

    it('finds a snake_case name from a camelCase question and the other way round', async () => {
      const ada = await seed();

      expect(await search(ada.id, 'getConnectionPool')).toContain(
        'def get_connection_pool(settings):\n    return Pool()',
      );
      expect(await search(ada.id, 'get_connection_pool')).toContain(
        'def get_connection_pool(settings):\n    return Pool()',
      );
    });

    it('finds a name that starts with an acronym', async () => {
      const ada = await seed();

      expect(await search(ada.id, 'where is the HTTP server config?')).toContain(
        'export class HTTPServerConfig {}',
      );
      expect(await search(ada.id, 'HTTPServerConfig')).toContain(
        'export class HTTPServerConfig {}',
      );
    });

    it('finds a constant by its upper-case name or by words', async () => {
      const ada = await seed();

      expect(await search(ada.id, 'MAX_LOGIN_ATTEMPTS')).toEqual([
        'export const MAX_LOGIN_ATTEMPTS = 5;',
      ]);
      expect(await search(ada.id, 'max login attempts')).toEqual([
        'export const MAX_LOGIN_ATTEMPTS = 5;',
      ]);
    });

    it('does not stem: a plural or a longer name is not the same word', async () => {
      const ada = await seed();

      expect(await search(ada.id, 'order')).toEqual([]);
      expect(await search(ada.id, 'orders')).toEqual([
        'export function listOrders() { return []; }',
      ]);
    });

    it('ranks the chunk that holds the whole identifier above one that only shares a word', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'a.ts', content: 'function routerFactory() { auth(); }' },
        { path: 'b.ts', content: 'function createAuthRouter() { return build(); }' },
        { path: 'c.ts', content: 'function authGuard() {}' },
      ]);

      const [best] = await search(ada.id, 'createAuthRouter');

      expect(best).toBe('function createAuthRouter() { return build(); }');
    });
  });

  describe('paths and symbols', () => {
    it('finds code by the names in its path', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/auth/routes.ts', content: 'router.post(handler);' },
        { path: 'src/orders/routes.ts', content: 'router.get(handler);' },
      ]);

      expect(await search(ada.id, 'auth routes')).toEqual([
        'router.post(handler);',
        'router.get(handler);',
      ]);
      expect(await search(ada.id, 'src/auth/routes.ts')).toContain('router.post(handler);');
      expect((await search(ada.id, 'auth'))[0]).toBe('router.post(handler);');
    });

    it('finds code by the symbol the chunk was named after', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/a.ts', symbol: 'SessionStore.create', content: 'return makeSession(userId);' },
        { path: 'src/b.ts', symbol: null, content: 'return other();' },
      ]);

      expect(await search(ada.id, 'SessionStore create')).toEqual(['return makeSession(userId);']);
    });
  });

  describe('questions', () => {
    it('ignores the filler of a question and searches on its content words', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/auth.ts', content: 'function login(user) { return verifyPassword(user); }' },
        { path: 'src/is.ts', content: 'the code is what it is, where is it' },
      ]);

      expect(await search(ada.id, 'Where is the login implemented?')).toEqual([
        'function login(user) { return verifyPassword(user); }',
      ]);
    });

    it('returns nothing for a question made only of filler', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'a.ts', content: 'the is what' },
      ]);

      expect(await search(ada.id, 'what is this?')).toEqual([]);
    });

    it('is not fooled by query syntax in the question', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'a.ts', content: 'function foo() {}' },
      ]);

      await expect(
        search(ada.id, `foo' | !bar & (baz:*) <-> "x"; drop table chunks;--`),
      ).resolves.toEqual(['function foo() {}']);
      expect(await db.select().from(chunks)).toHaveLength(1);
    });
  });

  describe('mixed libraries', () => {
    it('searches documents as prose and repositories as code, in one call', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'document', 'handbook.txt', [
        { content: 'Employees may work remotely on Fridays.' },
      ]);
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/remote.ts', content: 'export const allowRemoteWork = true;' },
      ]);

      const found = await search(ada.id, 'remote work');

      expect(found).toHaveLength(2);
      expect(found).toContain('Employees may work remotely on Fridays.');
      expect(found).toContain('export const allowRemoteWork = true;');
    });

    it('does not treat a document as code, so prose still gets stemming and stop words', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'document', 'handbook.txt', [
        { content: 'Employees may work remotely on Fridays.' },
      ]);

      expect(await search(ada.id, 'who works remotely')).toEqual([
        'Employees may work remotely on Fridays.',
      ]);
      const [row] = await db.select().from(chunks);
      expect(row?.codeSearchVector).toBeNull();
    });

    it('does not treat a repository as prose', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/a.ts', content: 'Employees may work remotely on Fridays.' },
      ]);

      const [row] = await db.select().from(chunks);
      expect(row?.searchVector).toBeTruthy();
      expect(await search(ada.id, 'works')).toEqual([]);
    });
  });

  describe('access', () => {
    it('never returns another user’s code', async () => {
      const ada = await createUser('ada@example.com');
      const grace = await createUser('grace@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'a.ts', content: 'function secretSauce() {}' },
      ]);

      expect(await search(grace.id, 'secretSauce')).toEqual([]);
      expect(await search(ada.id, 'secretSauce')).toHaveLength(1);
    });

    it('ignores code indexed with another embedding model', async () => {
      const ada = await createUser('ada@example.com');
      const doc = await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'a.ts', content: 'function legacy() {}' },
      ]);
      await db.update(documents).set({ embeddingModel: 'old' }).where(eq(documents.id, doc.id));
      const current = createRetrievalStore(db, { embeddingModel: 'new' });

      expect(await current.keywordSearch(ada.id, 'legacy', 5)).toEqual([]);
      expect(
        await createRetrievalStore(db, { embeddingModel: 'old' }).keywordSearch(
          ada.id,
          'legacy',
          5,
        ),
      ).toHaveLength(1);
    });
  });

  describe('the location of a result', () => {
    it('is returned by keyword search for code and left out for a document', async () => {
      const ada = await createUser('ada@example.com');
      const repo = await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/a.ts', symbol: 'login', content: 'function login() {}' },
      ]);
      await db
        .update(chunks)
        .set({ language: 'typescript', startLine: 4, endLine: 9 })
        .where(eq(chunks.documentId, repo.id));
      await addSource(ada.id, 'document', 'handbook.txt', [{ content: 'login is explained here' }]);

      const results = await store.keywordSearch(ada.id, 'login', 5);

      const file = results.find((r) => r.filename === 'acme/shop');
      const prose = results.find((r) => r.filename === 'handbook.txt');
      expect(file?.code).toEqual({
        path: 'src/a.ts',
        language: 'typescript',
        startLine: 4,
        endLine: 9,
        symbol: 'login',
      });
      expect(prose).toBeDefined();
      expect(prose).not.toHaveProperty('code');
    });

    it('is returned by vector search too', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'src/a.ts', content: 'function login() {}' },
      ]);
      await addSource(ada.id, 'document', 'handbook.txt', [{ content: 'plain text' }]);

      const results = await store.vectorSearch(ada.id, embedding(0), 5);

      expect(results.map((r) => r.code?.path ?? null).sort()).toEqual([null, 'src/a.ts']);
      expect(results.find((r) => r.code)).not.toHaveProperty('path');
    });
  });

  describe('the index', () => {
    it('has a GIN index on the code vector and fills the vector itself', async () => {
      const ada = await createUser('ada@example.com');
      await addSource(ada.id, 'repository', 'acme/shop', [
        { path: 'a.ts', content: 'function foo() {}' },
      ]);

      const indexes = await db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes where indexname = 'chunks_code_search_vector_idx'`,
      );
      const [row] = await db.select().from(chunks);

      expect(indexes.rows[0]?.indexdef).toMatch(/USING gin/);
      expect(row?.codeSearchVector).toContain("'foo'");
    });
  });
});
