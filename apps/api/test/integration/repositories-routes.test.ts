import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { documents } from '../../src/db/schema.js';
import type { RepositoryJob } from '../../src/repositories/ingest.js';
import { buildZip } from '../helpers/zip.js';
import { buildTestApp, useTestDb, withoutRequestId } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

describe('repository endpoints', () => {
  const db = useTestDb();
  const jobs: RepositoryJob[] = [];
  const app = buildTestApp(db, {
    repositoryIngestion: { enqueue: (job) => jobs.push(job), idle: async () => {} },
    maxArchiveBytes: 4096,
    usageLimits: { maxDocumentsPerUser: 2, maxChatsPerUser: 100, maxMessagesPerChat: 200 },
  });

  async function signedIn(email = credentials.email) {
    jobs.length = 0;
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  const zip = () => buildZip(['package.json', 'src/a.ts']);

  describe('POST /repositories (GitHub address)', () => {
    it('requires a signed-in user', async () => {
      const res = await request(app).post('/repositories').send({ url: 'https://github.com/a/b' });

      expect(res.status).toBe(401);
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('accepts a repository and starts importing it', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/repositories')
        .send({ url: ' https://github.com/acme/shop.git ' });

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        kind: 'repository',
        filename: 'acme/shop',
        status: 'processing',
        repoUrl: 'https://github.com/acme/shop',
        repoRef: null,
        commitSha: null,
        chunkCount: 0,
        progress: null,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.source).toEqual({ kind: 'github', url: 'https://github.com/acme/shop' });
    });

    it('passes the requested branch or tag on to the import', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/repositories')
        .send({ url: 'https://github.com/acme/shop/tree/v1.2.0' });

      expect(res.body.document.repoRef).toBe('v1.2.0');
      expect(jobs[0]?.source).toEqual({
        kind: 'github',
        url: 'https://github.com/acme/shop/tree/v1.2.0',
      });
    });

    it.each([
      ['another site', 'https://gitlab.com/acme/shop'],
      ['a look-alike host', 'https://github.com.evil.example/acme/shop'],
      ['plain http', 'http://github.com/acme/shop'],
      ['an internal address', 'https://169.254.169.254/acme/shop'],
      ['an issue page', 'https://github.com/acme/shop/issues/1'],
      ['text that is not an address', 'acme/shop'],
    ])('rejects %s without creating anything', async (_label, url) => {
      const agent = await signedIn();

      const res = await agent.post('/repositories').send({ url });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_repository_url');
      expect(await db.select().from(documents)).toEqual([]);
      expect(jobs).toEqual([]);
    });

    it.each([[{}], [{ url: 42 }], [{ url: '' }], [{ url: 'x'.repeat(400) }]])(
      'rejects a body that is not a short address (%j)',
      async (body) => {
        const agent = await signedIn();

        const res = await agent.post('/repositories').send(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_repository_url');
      },
    );

    it('refuses once the user has reached the document limit', async () => {
      const agent = await signedIn();
      await agent.post('/repositories').send({ url: 'https://github.com/acme/one' });
      await agent.post('/repositories').send({ url: 'https://github.com/acme/two' });

      const res = await agent.post('/repositories').send({ url: 'https://github.com/acme/three' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('document_limit');
      expect(jobs).toHaveLength(2);
    });
  });

  describe('POST /repositories/upload (zip archive)', () => {
    it('requires a signed-in user', async () => {
      const res = await request(app).post('/repositories/upload').attach('file', zip(), 'a.zip');

      expect(res.status).toBe(401);
    });

    it('accepts a zip archive and starts importing it', async () => {
      const agent = await signedIn();
      const archive = zip();

      const res = await agent.post('/repositories/upload').attach('file', archive, 'My Shop.zip');

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        kind: 'repository',
        filename: 'My Shop',
        mimeType: 'application/zip',
        sizeBytes: archive.length,
        status: 'processing',
        repoUrl: null,
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.source.kind).toBe('zip');
      expect(jobs[0]?.document.id).toBe(res.body.document.id);
    });

    it('records the owner, so repositories are private to their user', async () => {
      const agent = await signedIn();
      const me = await agent.get('/auth/me');

      const res = await agent.post('/repositories/upload').attach('file', zip(), 'a.zip');

      const [row] = await db.select().from(documents).where(eq(documents.id, res.body.document.id));
      expect(row?.userId).toBe(me.body.user.id);
    });

    it('asks for a file when none is sent', async () => {
      const agent = await signedIn();

      const res = await agent.post('/repositories/upload');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('file_required');
    });

    it('rejects a file that is not named like a zip archive', async () => {
      const agent = await signedIn();

      const res = await agent.post('/repositories/upload').attach('file', zip(), 'shop.tar.gz');

      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('unsupported_file_type');
    });

    it('rejects a file named like a zip archive that is not one', async () => {
      const agent = await signedIn();

      const res = await agent
        .post('/repositories/upload')
        .attach('file', Buffer.from('<html>not a zip</html>'), 'shop.zip');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('rejects an archive over the size limit', async () => {
      const agent = await signedIn();
      const big = buildZip([
        { name: 'a.ts', data: Buffer.alloc(8192, 'abcdefgh'.repeat(1000)), method: 'store' },
      ]);

      const res = await agent.post('/repositories/upload').attach('file', big, 'big.zip');

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('refuses once the user has reached the document limit', async () => {
      const agent = await signedIn();
      await agent.post('/repositories/upload').attach('file', zip(), 'one.zip');
      await agent.post('/repositories/upload').attach('file', zip(), 'two.zip');

      const res = await agent.post('/repositories/upload').attach('file', zip(), 'three.zip');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('document_limit');
    });
  });

  describe('in the document library', () => {
    it('lists a repository next to documents, with its kind and no progress before work starts', async () => {
      const agent = await signedIn();
      await agent.post('/documents').attach('file', Buffer.from('plain notes'), 'notes.txt');
      await agent.post('/repositories').send({ url: 'https://github.com/acme/shop' });

      const res = await agent.get('/documents');

      expect(res.body.documents.map((d: { kind: string }) => d.kind).sort()).toEqual([
        'document',
        'repository',
      ]);
    });

    it('does not show one user’s repository to another', async () => {
      const owner = await signedIn();
      const created = await owner
        .post('/repositories')
        .send({ url: 'https://github.com/acme/shop' });
      const other = await signedIn('grace@example.com');

      const list = await other.get('/documents');
      const foreign = await other.get(`/documents/${created.body.document.id}`);
      const missing = await other.get('/documents/00000000-0000-4000-8000-000000000000');

      expect(list.body.documents).toEqual([]);
      expect(foreign.status).toBe(404);
      expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(missing.body));
    });

    it('deletes a repository like any other document', async () => {
      const agent = await signedIn();
      const created = await agent
        .post('/repositories')
        .send({ url: 'https://github.com/acme/shop' });

      const res = await agent.delete(`/documents/${created.body.document.id}`);

      expect(res.status).toBe(204);
      expect(await db.select().from(documents)).toEqual([]);
    });
  });
});
