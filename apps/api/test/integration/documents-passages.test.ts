import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { chunks, documents } from '../../src/db/schema.js';
import { fakeVector } from '../helpers/embedder.js';
import { buildTestApp, useTestDb } from './helpers.js';

const password = 'correct horse battery';
const MISSING_ID = '3f0c6f6e-8d2a-4b7e-9a51-5c1d2e7f9a10';

describe('document passages', () => {
  const db = useTestDb();
  const app = buildTestApp(db);

  async function signedIn(email: string) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/register').send({ email, password });
    return { agent, userId: res.body.user.id as string };
  }

  async function addDocument(userId: string, count: number, filename = 'handbook.pdf') {
    const [document] = await db
      .insert(documents)
      .values({
        userId,
        filename,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        status: 'ready',
        pageCount: 3,
      })
      .returning();
    await db.insert(chunks).values(
      Array.from({ length: count }, (_, ordinal) => ({
        documentId: document!.id,
        userId,
        ordinal,
        page: Math.floor(ordinal / 2) + 1,
        content: `passage ${ordinal}`,
        tokenCount: 3,
        embedding: fakeVector(`passage ${ordinal}`),
      })),
    );
    return document!;
  }

  const ordinals = (body: { passages: Array<{ ordinal: number }> }) =>
    body.passages.map((p) => p.ordinal);

  it('requires a signed-in user', async () => {
    const res = await request(app).get(`/documents/${MISSING_ID}/passages?ordinal=0`);

    expect(res.status).toBe(401);
  });

  it('returns the passage with one neighbour on each side, in reading order', async () => {
    const { agent, userId } = await signedIn('ann@example.com');
    const document = await addDocument(userId, 10);

    const res = await agent.get(`/documents/${document.id}/passages?ordinal=5`);

    expect(res.status).toBe(200);
    expect(ordinals(res.body)).toEqual([4, 5, 6]);
    expect(res.body.target).toBe(5);
    expect(res.body.passages[1]).toEqual({ ordinal: 5, page: 3, content: 'passage 5' });
    expect(res.body.document).toEqual({
      id: document.id,
      filename: 'handbook.pdf',
      pageCount: 3,
      kind: 'document',
      repoUrl: null,
      commitSha: null,
    });
  });

  it('honours the radius, down to the passage alone', async () => {
    const { agent, userId } = await signedIn('ann@example.com');
    const document = await addDocument(userId, 10);

    const wide = await agent.get(`/documents/${document.id}/passages?ordinal=5&radius=3`);
    const alone = await agent.get(`/documents/${document.id}/passages?ordinal=5&radius=0`);

    expect(ordinals(wide.body)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(ordinals(alone.body)).toEqual([5]);
  });

  it('stops at the start and at the end of the document', async () => {
    const { agent, userId } = await signedIn('ann@example.com');
    const document = await addDocument(userId, 4);

    const first = await agent.get(`/documents/${document.id}/passages?ordinal=0&radius=2`);
    const last = await agent.get(`/documents/${document.id}/passages?ordinal=3&radius=2`);

    expect(ordinals(first.body)).toEqual([0, 1, 2]);
    expect(ordinals(last.body)).toEqual([1, 2, 3]);
  });

  it.each([
    ['a missing ordinal', 'radius=1'],
    ['a negative ordinal', 'ordinal=-1'],
    ['a fractional ordinal', 'ordinal=1.5'],
    ['a text ordinal', 'ordinal=abc'],
    ['a radius above the maximum', 'ordinal=1&radius=4'],
    ['a negative radius', 'ordinal=1&radius=-1'],
  ])('rejects %s', async (_name, query) => {
    const { agent, userId } = await signedIn('ann@example.com');
    const document = await addDocument(userId, 4);

    const res = await agent.get(`/documents/${document.id}/passages?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('is a 404 for a passage the document does not have', async () => {
    const { agent, userId } = await signedIn('ann@example.com');
    const document = await addDocument(userId, 4);

    const res = await agent.get(`/documents/${document.id}/passages?ordinal=9`);

    expect(res.status).toBe(404);
  });

  it('is a 404 for an unknown or malformed document id', async () => {
    const { agent } = await signedIn('ann@example.com');

    const missing = await agent.get(`/documents/${MISSING_ID}/passages?ordinal=0`);
    const malformed = await agent.get('/documents/nope/passages?ordinal=0');

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
  });

  it("never reveals another user's document", async () => {
    const ann = await signedIn('ann@example.com');
    const bob = await signedIn('bob@example.com');
    const secret = await addDocument(ann.userId, 4, 'secret.pdf');

    const res = await bob.agent.get(`/documents/${secret.id}/passages?ordinal=1`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('passage');
    expect(JSON.stringify(res.body)).not.toContain('secret.pdf');
  });

  describe('of a repository', () => {
    const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

    async function addRepository(userId: string) {
      const [repo] = await db
        .insert(documents)
        .values({
          userId,
          kind: 'repository',
          filename: 'acme/shop',
          mimeType: 'application/zip',
          sizeBytes: 0,
          status: 'ready',
          repoUrl: 'https://github.com/acme/shop',
          commitSha: SHA,
        })
        .returning();
      await db.insert(chunks).values([
        {
          documentId: repo!.id,
          userId,
          ordinal: 0,
          content: '# Repository overview',
          tokenCount: 3,
          embedding: fakeVector('overview'),
          path: 'REPOSITORY_OVERVIEW',
          language: 'markdown',
          startLine: 1,
          endLine: 1,
        },
        {
          documentId: repo!.id,
          userId,
          ordinal: 1,
          content: 'export function login() {}',
          tokenCount: 6,
          embedding: fakeVector('login'),
          path: 'src/auth/login.ts',
          language: 'typescript',
          startLine: 12,
          endLine: 12,
          symbol: 'login',
        },
        {
          documentId: repo!.id,
          userId,
          ordinal: 2,
          content: 'export function logout() {}',
          tokenCount: 6,
          embedding: fakeVector('logout'),
          path: 'src/auth/login.ts',
          language: 'typescript',
          startLine: 14,
          endLine: 14,
          symbol: 'logout',
        },
      ]);
      return repo!;
    }

    it('gives each passage its file, language, lines and symbol', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const repo = await addRepository(userId);

      const res = await agent.get(`/documents/${repo.id}/passages?ordinal=1&radius=1`);

      expect(res.status).toBe(200);
      expect(res.body.passages).toEqual([
        {
          ordinal: 0,
          page: null,
          content: '# Repository overview',
          code: {
            path: 'REPOSITORY_OVERVIEW',
            language: 'markdown',
            startLine: 1,
            endLine: 1,
            symbol: null,
          },
        },
        {
          ordinal: 1,
          page: null,
          content: 'export function login() {}',
          code: {
            path: 'src/auth/login.ts',
            language: 'typescript',
            startLine: 12,
            endLine: 12,
            symbol: 'login',
          },
        },
        {
          ordinal: 2,
          page: null,
          content: 'export function logout() {}',
          code: {
            path: 'src/auth/login.ts',
            language: 'typescript',
            startLine: 14,
            endLine: 14,
            symbol: 'logout',
          },
        },
      ]);
    });

    it('says where the repository came from, so a link to the same lines can be made', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const repo = await addRepository(userId);

      const res = await agent.get(`/documents/${repo.id}/passages?ordinal=1&radius=0`);

      expect(res.body.document).toEqual({
        id: repo.id,
        filename: 'acme/shop',
        pageCount: null,
        kind: 'repository',
        repoUrl: 'https://github.com/acme/shop',
        commitSha: SHA,
      });
    });

    it('does not add a code location to a passage of an ordinary document', async () => {
      const { agent, userId } = await signedIn('ann@example.com');
      const doc = await addDocument(userId, 3);

      const res = await agent.get(`/documents/${doc.id}/passages?ordinal=1&radius=0`);

      expect(res.body.passages[0]).not.toHaveProperty('code');
    });

    it('is private to its owner', async () => {
      const ann = await signedIn('ann@example.com');
      const bob = await signedIn('bob@example.com');
      const repo = await addRepository(ann.userId);

      const res = await bob.agent.get(`/documents/${repo.id}/passages?ordinal=1`);

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('login');
    });
  });
});
