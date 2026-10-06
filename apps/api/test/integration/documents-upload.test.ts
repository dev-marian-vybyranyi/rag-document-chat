import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { documents } from '../../src/db/schema.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };
const text = Buffer.from('Embeddings turn text into vectors.');
const pdf = Buffer.from('%PDF-1.4\n%minimal\n');

describe('POST /documents', () => {
  const db = useTestDb();
  const app = buildTestApp(db, { maxUploadBytes: 1024 });

  async function signedInAgent(email = credentials.email) {
    const agent = request.agent(app);
    await agent.post('/auth/register').send({ ...credentials, email });
    return agent;
  }

  describe('access', () => {
    it('requires a signed-in user', async () => {
      const res = await request(app).post('/documents').attach('file', text, 'notes.txt');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
      expect(await db.select().from(documents)).toEqual([]);
    });
  });

  describe('accepted files', () => {
    it('stores a text file as a document that is being processed', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', text, 'notes.txt');

      expect(res.status).toBe(202);
      expect(res.body.document).toMatchObject({
        id: expect.any(String),
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: text.length,
        status: 'processing',
        error: null,
        pageCount: null,
      });
    });

    it('records the owner, so documents are private to their user', async () => {
      const agent = await signedInAgent();
      const me = await agent.get('/auth/me');

      const res = await agent.post('/documents').attach('file', text, 'notes.txt');

      const [row] = await db.select().from(documents).where(eq(documents.id, res.body.document.id));
      expect(row?.userId).toBe(me.body.user.id);
    });

    it.each([
      ['report.pdf', pdf, 'application/pdf'],
      ['README.md', Buffer.from('# Title\n\nBody'), 'text/markdown'],
    ])('accepts %s', async (filename, content, mimeType) => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', content, filename);

      expect(res.status).toBe(202);
      expect(res.body.document.mimeType).toBe(mimeType);
    });

    it('trusts the extension, not the MIME type the browser claims', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', Buffer.from('# Notes'), {
        filename: 'notes.md',
        contentType: 'application/octet-stream',
      });

      expect(res.status).toBe(202);
      expect(res.body.document.mimeType).toBe('text/markdown');
    });

    it('keeps a non-ASCII filename intact', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', text, 'Звіт за 2025.txt');

      expect(res.body.document.filename).toBe('Звіт за 2025.txt');
    });

    it('stores only the file name when the client sends a path', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', text, '../../etc/notes.txt');

      expect(res.body.document.filename).toBe('notes.txt');
    });
  });

  describe('rejected files', () => {
    it('asks for a file when none is sent', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('file_required');
    });

    it.each(['malware.exe', 'letter.docx', 'archive.zip', 'noextension'])(
      'refuses the unsupported type %s with 415',
      async (filename) => {
        const agent = await signedInAgent();

        const res = await agent.post('/documents').attach('file', text, filename);

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('unsupported_file_type');
      },
    );

    it('refuses a .pdf that is not a PDF', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', text, 'fake.pdf');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'invalid_file',
        message: 'The file is not a valid PDF',
      });
    });

    it('refuses a .txt that is binary', async () => {
      const agent = await signedInAgent();

      const res = await agent
        .post('/documents')
        .attach('file', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), 'archive.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
    });

    it('refuses an empty file', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', Buffer.alloc(0), 'empty.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('The file is empty');
    });

    it('refuses a file over the size limit with 413 and stores nothing', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('file', Buffer.alloc(2048, 'a'), 'big.txt');

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('file_too_large');
      expect(await db.select().from(documents)).toEqual([]);
    });

    it('accepts a file exactly at the limit', async () => {
      const agent = await signedInAgent();

      const res = await agent
        .post('/documents')
        .attach('file', Buffer.alloc(1024, 'a'), 'edge.txt');

      expect(res.status).toBe(202);
    });

    it('refuses more than one file', async () => {
      const agent = await signedInAgent();

      const res = await agent
        .post('/documents')
        .attach('file', text, 'one.txt')
        .attach('file', text, 'two.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it('refuses a file sent under the wrong field name', async () => {
      const agent = await signedInAgent();

      const res = await agent.post('/documents').attach('document', text, 'notes.txt');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_upload');
    });

    it('refuses extra form fields', async () => {
      const agent = await signedInAgent();

      const res = await agent
        .post('/documents')
        .field('userId', 'someone-else')
        .attach('file', text, 'notes.txt');

      expect(res.status).toBe(400);
      expect(await db.select().from(documents)).toEqual([]);
    });
  });
});
