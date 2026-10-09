import { eq, ilike } from 'drizzle-orm';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EmbeddingError, type Embedder } from '../../src/ai/embeddings.js';
import { chunks, documents } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';
import { defaultImportLimits } from '../../src/repositories/filter.js';
import { createGithubImporter } from '../../src/repositories/github.js';
import {
  createRepositoryIngestion,
  type RepositoryIngestionOptions,
} from '../../src/repositories/ingest.js';
import { OVERVIEW_PATH } from '../../src/repositories/overview.js';
import { createFakeEmbedder } from '../helpers/embedder.js';
import { sampleRepoEntries, SECRET_MARKERS } from '../helpers/sample-repo.js';
import { buildZip } from '../helpers/zip.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };
const SHA = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

type Setup = Partial<Omit<RepositoryIngestionOptions, 'repository' | 'embedder' | 'github'>>;

describe('repository ingestion', () => {
  const db = useTestDb();
  const repository = createDocumentRepository(db);

  function githubServing(archive: () => Response, sha: () => Response = () => new Response(SHA)) {
    const requested: string[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return url.startsWith('https://api.github.com') ? sha() : archive();
    }) as typeof fetch;
    return { github: createGithubImporter({ fetch: fetchStub }), requested };
  }

  function setup(
    options: {
      embedder?: Embedder;
      github?: ReturnType<typeof githubServing>['github'];
    } & Setup = {},
  ) {
    const {
      embedder = createFakeEmbedder(),
      github = githubServing(() => new Response('')).github,
      ...rest
    } = options;
    const ingestion = createRepositoryIngestion({
      repository,
      embedder,
      github,
      logger: pino({ level: 'silent' }),
      embeddingModel: 'fake-model',
      ...rest,
    });
    const app = buildTestApp(db, { repositoryIngestion: ingestion });
    return { app, ingestion, embedder };
  }

  async function signedIn(app: ReturnType<typeof buildTestApp>, email = credentials.email) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  async function uploadZip(app: ReturnType<typeof buildTestApp>, zip: Buffer, name = 'shop.zip') {
    const agent = await signedIn(app);
    const res = await agent.post('/repositories/upload').attach('file', zip, name);
    return { agent, res, id: res.body.document?.id as string };
  }

  const documentRow = async (id: string) =>
    (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const chunkRows = (id: string) =>
    db.select().from(chunks).where(eq(chunks.documentId, id)).orderBy(chunks.ordinal);

  describe('an uploaded archive', () => {
    it('becomes a ready repository with its files, passages and overview', async () => {
      const { app, ingestion } = setup();

      const { id } = await uploadZip(app, buildZip(sampleRepoEntries()));
      await ingestion.idle();

      expect(await documentRow(id)).toMatchObject({
        kind: 'repository',
        filename: 'shop',
        status: 'ready',
        error: null,
        fileCount: 10,
        embeddingModel: 'fake-model',
        progressPhase: null,
        progressDone: null,
        progressTotal: null,
      });
    });

    it('stores every passage with its path, language, lines and symbol', async () => {
      const { app, ingestion } = setup();

      const { id } = await uploadZip(app, buildZip(sampleRepoEntries()));
      await ingestion.idle();

      const rows = await chunkRows(id);
      expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i));
      const orders = rows.find((r) => r.path === 'src/orders/list.ts');
      expect(orders).toMatchObject({
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        symbol: 'listOrders',
        page: null,
        content: 'export async function listOrders() { return []; }',
      });
      const charge = rows.find((r) => r.path === 'src/payments/charge.py');
      expect(charge).toMatchObject({ language: 'python', symbol: 'charge' });
    });

    it('indexes a repository overview first, at a virtual path', async () => {
      const { app, ingestion } = setup();

      const { id } = await uploadZip(app, buildZip(sampleRepoEntries()));
      await ingestion.idle();

      const rows = await chunkRows(id);
      const overview = rows.filter((r) => r.path === OVERVIEW_PATH);
      expect(overview.length).toBeGreaterThan(0);
      expect(rows[0]?.path).toBe(OVERVIEW_PATH);
      expect(overview.map((r) => r.content).join('\n')).toContain('- express ^5.0.0');
    });

    it('embeds the path, lines and symbol together with the code, but stores the code alone', async () => {
      const { app, ingestion, embedder } = setup();

      const { id } = await uploadZip(app, buildZip(sampleRepoEntries()));
      await ingestion.idle();

      const embedded = (embedder as ReturnType<typeof createFakeEmbedder>).documentCalls.flat();
      expect(embedded).toContain(
        'src/orders/list.ts (typescript), lines 1-1, listOrders\n\nexport async function listOrders() { return []; }',
      );
      const stored = (await chunkRows(id)).find((r) => r.path === 'src/orders/list.ts');
      expect(stored?.content.startsWith('export')).toBe(true);
    });

    it('never stores a secret or a file that was left out', async () => {
      const { app, ingestion } = setup();

      const { id } = await uploadZip(app, buildZip(sampleRepoEntries()));
      await ingestion.idle();

      for (const marker of SECRET_MARKERS) {
        expect(
          await db
            .select()
            .from(chunks)
            .where(ilike(chunks.content, `%${marker}%`)),
        ).toEqual([]);
      }
      const paths = (await chunkRows(id)).map((r) => r.path);
      expect(paths).not.toContain('.env');
      expect(paths).not.toContain('node_modules/express/index.js');
    });

    it('reports progress while it embeds, in steps of one group of passages', async () => {
      const entries = Array.from({ length: 230 }, (_, i) => ({
        name: `src/m${i}.ts`,
        data: `export const value${i} = ${i};\n`,
      }));
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
      const { app, ingestion } = setup({ embedder });

      const { id } = await uploadZip(
        app,
        buildZip([{ name: 'package.json', data: '{}' }, ...entries]),
      );
      await ingestion.idle();

      const total = (await chunkRows(id)).length;
      expect(total).toBeGreaterThan(230);
      expect(seen).toEqual([
        { phase: 'embedding', done: 0, total },
        { phase: 'embedding', done: 100, total },
        { phase: 'embedding', done: 200, total },
      ]);
    });

    it('shows the progress to the owner while the repository is processing', async () => {
      const session: { agent?: ReturnType<typeof request.agent> } = {};
      let midway: unknown;
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          midway = (await session.agent!.get('/documents')).body.documents[0];
        },
      });
      const { app, ingestion } = setup({ embedder });

      const result = await uploadZip(app, buildZip(sampleRepoEntries()));
      session.agent = result.agent;
      await ingestion.idle();

      expect(midway).toMatchObject({
        kind: 'repository',
        status: 'processing',
        progress: { phase: 'embedding' },
      });
      const done = (await result.agent.get(`/documents/${result.id}`)).body.document;
      expect(done).toMatchObject({ status: 'ready', progress: null, fileCount: 10 });
    });
  });

  describe('a GitHub repository', () => {
    it('is downloaded at one commit and records where it came from', async () => {
      const zip = buildZip(
        sampleRepoEntries().map((e) => ({ ...e, name: `shop-7fd1a60/${e.name}` })),
      );
      const { github, requested } = githubServing(() => new Response(new Uint8Array(zip)));
      const { app, ingestion } = setup({ github });
      const agent = await signedIn(app);

      const res = await agent
        .post('/repositories')
        .send({ url: 'https://github.com/acme/shop/tree/release%2F1.0' });
      await ingestion.idle();

      expect(res.status).toBe(202);
      expect(await documentRow(res.body.document.id)).toMatchObject({
        kind: 'repository',
        filename: 'acme/shop',
        status: 'ready',
        repoUrl: 'https://github.com/acme/shop',
        repoRef: 'release/1.0',
        commitSha: SHA,
        fileCount: 10,
      });
      expect(requested).toEqual([
        'https://api.github.com/repos/acme/shop/commits/release/1.0',
        `https://codeload.github.com/acme/shop/zip/${SHA}`,
      ]);
    });

    it('names the repository and commit in the overview', async () => {
      const zip = buildZip(sampleRepoEntries());
      const { github } = githubServing(() => new Response(new Uint8Array(zip)));
      const { app, ingestion } = setup({ github });
      const agent = await signedIn(app);

      const res = await agent.post('/repositories').send({ url: 'https://github.com/acme/shop' });
      await ingestion.idle();

      const [first] = await chunkRows(res.body.document.id);
      expect(first?.content).toContain('# Repository overview: acme/shop');
      expect(first?.content).toContain('Source: https://github.com/acme/shop (commit 7fd1a60)');
    });

    it('fails with a readable reason when the repository does not exist', async () => {
      const { github } = githubServing(
        () => new Response('', { status: 404 }),
        () => new Response('{}', { status: 404 }),
      );
      const { app, ingestion } = setup({ github });
      const agent = await signedIn(app);

      const res = await agent
        .post('/repositories')
        .send({ url: 'https://github.com/acme/missing' });
      await ingestion.idle();

      expect(await documentRow(res.body.document.id)).toMatchObject({
        status: 'failed',
        error: 'The repository was not found, or it is private',
        progressPhase: null,
      });
      expect(await chunkRows(res.body.document.id)).toEqual([]);
    });

    it('fails with a readable reason when GitHub is limiting requests', async () => {
      const { github } = githubServing(
        () => new Response(''),
        () => new Response('{}', { status: 429 }),
      );
      const { app, ingestion } = setup({ github });
      const agent = await signedIn(app);

      const res = await agent.post('/repositories').send({ url: 'https://github.com/acme/shop' });
      await ingestion.idle();

      expect(await documentRow(res.body.document.id)).toMatchObject({
        status: 'failed',
        error: 'GitHub is limiting requests right now. Try again later',
      });
    });
  });

  describe('when something goes wrong', () => {
    const failedWith = async (zip: Buffer, extra: Parameters<typeof setup>[0] = {}) => {
      const { app, ingestion } = setup(extra);
      const { id } = await uploadZip(app, zip);
      await ingestion.idle();
      return { row: await documentRow(id), rows: await chunkRows(id) };
    };

    it('fails an archive that tries to escape, without indexing anything', async () => {
      const zip = buildZip(['package.json', { name: '../../etc/passwd.ts', data: 'x' }]);

      const { row, rows } = await failedWith(zip);

      expect(row).toMatchObject({
        status: 'failed',
        error: 'The archive contains a file path that is not allowed',
      });
      expect(rows).toEqual([]);
    });

    it('fails an archive with nothing worth indexing', async () => {
      const { row } = await failedWith(buildZip([{ name: '.env', data: 'A=1' }, 'logo.png']));

      expect(row.status).toBe('failed');
      expect(row.error).toMatch(/no source, documentation/);
    });

    it('fails a repository that has too many files', async () => {
      const limits = { ...defaultImportLimits, maxFiles: 2 };

      const { row } = await failedWith(buildZip(['a.ts', 'b.ts', 'c.ts']), { limits });

      expect(row.error).toMatch(/3 indexable files; the limit is 2/);
    });

    it('fails a repository that would make too many passages', async () => {
      const { row, rows } = await failedWith(buildZip(sampleRepoEntries()), { maxChunks: 5 });

      expect(row.error).toMatch(/too large to index: \d+ passages, the limit is 5/);
      expect(rows).toEqual([]);
    });

    it('fails with the embedding error and keeps no half-indexed repository', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new EmbeddingError('quota_exhausted');
        },
        embedQuery: async () => [],
      };

      const { row, rows } = await failedWith(buildZip(sampleRepoEntries()), { embedder });

      expect(row).toMatchObject({
        status: 'failed',
        error: new EmbeddingError('quota_exhausted').message,
      });
      expect(rows).toEqual([]);
    });

    it('hides the details of an unexpected failure', async () => {
      const embedder: Embedder = {
        embedDocuments: async () => {
          throw new Error('connection string postgres://secret@host leaked');
        },
        embedQuery: async () => [],
      };

      const { row } = await failedWith(buildZip(sampleRepoEntries()), { embedder });

      expect(row.error).toBe('Something went wrong while importing the repository.');
    });

    it('lets the next repository through after a failure', async () => {
      const { app, ingestion } = setup();
      const agent = await signedIn(app);
      await agent.post('/repositories/upload').attach('file', buildZip(['logo.png']), 'bad.zip');
      const good = await agent
        .post('/repositories/upload')
        .attach('file', buildZip(sampleRepoEntries()), 'good.zip');
      await ingestion.idle();

      expect((await documentRow(good.body.document.id)).status).toBe('ready');
    });

    it('stops quietly when the repository is deleted while it is being imported', async () => {
      const session: { agent?: ReturnType<typeof request.agent> } = {};
      const embedder = createFakeEmbedder({
        beforeEmbedDocuments: async () => {
          const [row] = await db.select().from(documents);
          await session.agent!.delete(`/documents/${row!.id}`);
        },
      });
      const { app, ingestion } = setup({ embedder });

      const result = await uploadZip(app, buildZip(sampleRepoEntries()));
      session.agent = result.agent;
      await ingestion.idle();

      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(chunks)).toEqual([]);
    });
  });
});
