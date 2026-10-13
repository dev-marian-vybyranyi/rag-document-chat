import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { documents, EMBEDDING_DIMENSIONS } from '../../src/db/schema.js';
import { createDocumentRepository } from '../../src/documents/repository.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const LAST_LEGACY_MIGRATION = '0007_embedding_model';

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

function migrationsUpTo(tag: string): string {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
  ) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  const folder = mkdtempSync(join(tmpdir(), 'legacy-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const kept = journal.entries.slice(0, last + 1);
  for (const entry of kept)
    cpSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  return folder;
}

describe('upgrading a database that already holds documents', () => {
  const baseUrl = new URL(inject('testDatabaseUrl'));
  const scratchName = `ragchat_upgrade_${process.pid}`;
  const scratchUrl = new URL(baseUrl);
  scratchUrl.pathname = `/${scratchName}`;
  const legacyFolder = migrationsUpTo(LAST_LEGACY_MIGRATION);

  async function withAdmin<T>(action: (admin: Client) => Promise<T>): Promise<T> {
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      return await action(admin);
    } finally {
      await admin.end();
    }
  }

  const { db, pool } = createDb(scratchUrl.toString());
  const userId = '00000000-0000-4000-8000-000000000001';
  const documentId = '00000000-0000-4000-8000-000000000002';
  const chatId = '00000000-0000-4000-8000-000000000003';
  const vector = `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01).join(',')}]`;

  beforeAll(async () => {
    await withAdmin(async (admin) => {
      await admin.query(`drop database if exists "${scratchName}"`);
      await admin.query(`create database "${scratchName}"`);
    });
    await migrate(db, { migrationsFolder: legacyFolder });
    await db.execute(
      sql`insert into users (id, email, password_hash) values (${userId}, 'ada@example.com', 'hash')`,
    );
    await db.execute(sql`
      insert into documents (id, user_id, filename, mime_type, size_bytes, status, page_count, embedding_model)
      values (${documentId}, ${userId}, 'handbook.pdf', 'application/pdf', 2048, 'ready', 2, 'gemini-embedding-001')
    `);
    await db.execute(sql`
      insert into chunks (document_id, user_id, ordinal, page, content, token_count, embedding)
      values (${documentId}, ${userId}, 0, 1, 'Remote work is allowed.', 5, ${vector}::vector)
    `);
    await db.execute(
      sql`insert into chats (id, user_id, title) values (${chatId}, ${userId}, 'Old chat')`,
    );
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  afterAll(async () => {
    await pool.end();
    await withAdmin((admin) => admin.query(`drop database if exists "${scratchName}"`));
    rmSync(legacyFolder, { recursive: true, force: true });
  });

  it('turns existing documents into plain documents', async () => {
    const found = await createDocumentRepository(db).findForUser(documentId, userId);

    expect(found).toMatchObject({
      kind: 'document',
      filename: 'handbook.pdf',
      status: 'ready',
      pageCount: 2,
      embeddingModel: 'gemini-embedding-001',
      chunkCount: 1,
    });
  });

  it('lists existing documents as before', async () => {
    const list = await createDocumentRepository(db).listByUser(userId);

    expect(list.map((d) => [d.filename, d.kind])).toEqual([['handbook.pdf', 'document']]);
  });

  it('keeps existing passages readable, without a code location', async () => {
    const result = await createDocumentRepository(db).passagesAround(documentId, userId, 0, 1);

    expect(result?.passages).toEqual([{ ordinal: 0, page: 1, content: 'Remote work is allowed.' }]);
  });

  it('leaves the code location of existing chunks empty', async () => {
    const rows = await db.execute<{ path: string | null; start_line: number | null }>(
      sql`select path, start_line from chunks where document_id = ${documentId}`,
    );

    expect(rows.rows).toEqual([{ path: null, start_line: null }]);
  });

  it('leaves the meeting fields of existing documents and chunks empty', async () => {
    const [found] = await createDocumentRepository(db).listByUser(userId);
    const chunkRows = await db.execute<{
      start_ms: number | null;
      end_ms: number | null;
      speakers: string[] | null;
    }>(sql`select start_ms, end_ms, speakers from chunks where document_id = ${documentId}`);

    expect(found).toMatchObject({
      meetingHeldOn: null,
      participants: null,
      durationMs: null,
      notes: null,
    });
    expect(chunkRows.rows).toEqual([{ start_ms: null, end_ms: null, speakers: null }]);
  });

  it('accepts a transcript next to the existing documents and reads its time and speakers back', async () => {
    const repository = createDocumentRepository(db);
    const transcript = await repository.create({
      userId,
      kind: 'transcript',
      filename: 'standup.txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
      meetingHeldOn: '2026-10-01',
    });
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
    await repository.completeWithChunks({
      documentId: transcript.id,
      userId,
      pageCount: null,
      participants: ['Alice', 'Bob'],
      durationMs: 90_000,
      notes: {
        summary: 'Short sync.',
        topics: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
      },
      chunks: [
        {
          ordinal: 0,
          page: null,
          content: '[00:00:05] Alice: Hello.',
          tokenCount: 6,
          embedding,
          startMs: 5000,
          endMs: 65_000,
          speakers: ['Alice', 'Bob'],
        },
        {
          ordinal: 1,
          page: null,
          content: 'Meeting notes',
          tokenCount: 2,
          embedding,
          speakers: ['Alice', 'Bob'],
        },
      ],
    });

    const found = await repository.findForUser(transcript.id, userId);
    const around = await repository.passagesAround(transcript.id, userId, 0, 1);
    const documents = await repository.listByUser(userId);

    expect(found).toMatchObject({
      kind: 'transcript',
      meetingHeldOn: '2026-10-01',
      participants: ['Alice', 'Bob'],
      durationMs: 90_000,
      notes: { summary: 'Short sync.' },
    });
    expect(around?.passages.map((p) => p.meeting)).toEqual([
      { startMs: 5000, endMs: 65_000, speakers: ['Alice', 'Bob'] },
      { startMs: null, endMs: null, speakers: ['Alice', 'Bob'] },
    ]);
    expect(documents.map((d) => [d.filename, d.kind]).sort()).toEqual([
      ['handbook.pdf', 'document'],
      ['standup.txt', 'transcript'],
    ]);
  });

  it('leaves the career fields of existing documents and chunks empty', async () => {
    const [found] = await db.select().from(documents).where(eq(documents.id, documentId));
    const chunkRows = await db.execute<{ section: string | null }>(
      sql`select section from chunks where document_id = ${documentId}`,
    );

    expect(found).toMatchObject({ profile: null, jobNumber: null, fit: null });
    expect(chunkRows.rows).toEqual([{ section: null }]);
  });

  it('accepts a resume and a job posting next to the existing sources and reads their career fields back', async () => {
    const repository = createDocumentRepository(db);
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
    const resume = await repository.create({
      userId,
      kind: 'resume',
      filename: 'cv.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
    });
    const job = await repository.create({
      userId,
      kind: 'job_posting',
      filename: 'Backend Engineer',
      mimeType: 'text/plain',
      sizeBytes: 100,
      jobNumber: 1,
    });
    await repository.completeWithChunks({
      documentId: resume.id,
      userId,
      pageCount: 1,
      chunks: [
        {
          ordinal: 0,
          page: 1,
          content: 'Resume · Experience',
          tokenCount: 3,
          embedding,
          section: 'experience',
        },
      ],
    });
    await db
      .update(documents)
      .set({
        profile: {
          role: 'job',
          title: 'Backend Engineer',
          company: 'Acme',
          minYearsExperience: 5,
          requirements: [],
          responsibilities: [],
        },
        fit: {
          resumeId: resume.id,
          analyzedAt: '2026-10-13T10:00:00.000Z',
          requirements: [],
          coverage: 72,
          mustCoverage: 80,
        },
      })
      .where(eq(documents.id, job.id));

    const foundResume = await repository.findForUser(resume.id, userId);
    const foundJob = await repository.findForUser(job.id, userId);
    const sections = await db.execute<{ section: string | null }>(
      sql`select section from chunks where document_id = ${resume.id}`,
    );

    expect(foundResume).toMatchObject({ kind: 'resume', jobNumber: null, chunkCount: 1 });
    expect(foundJob).toMatchObject({
      kind: 'job_posting',
      jobNumber: 1,
      profile: { role: 'job', company: 'Acme' },
      fit: { resumeId: resume.id, coverage: 72 },
    });
    expect(sections.rows).toEqual([{ section: 'experience' }]);
  });

  it('keeps one resume per user, whatever the application checks first', async () => {
    const repository = createDocumentRepository(db);
    const otherUserId = '00000000-0000-4000-8000-000000000008';
    await db.execute(
      sql`insert into users (id, email, password_hash) values (${otherUserId}, 'linus@example.com', 'hash')`,
    );
    const resume = (owner: string) =>
      repository.create({
        userId: owner,
        kind: 'resume',
        filename: 'second.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      });

    await expect(resume(userId)).rejects.toThrow();
    await expect(resume(otherUserId)).resolves.toMatchObject({ kind: 'resume' });
  });

  it('numbers job postings per user and lets documents without a number repeat', async () => {
    const repository = createDocumentRepository(db);
    const otherUserId = '00000000-0000-4000-8000-000000000009';
    await db.execute(
      sql`insert into users (id, email, password_hash) values (${otherUserId}, 'grace@example.com', 'hash')`,
    );
    const posting = (owner: string, jobNumber?: number) =>
      repository.create({
        userId: owner,
        kind: 'job_posting',
        filename: 'Posting',
        mimeType: 'text/plain',
        sizeBytes: 10,
        ...(jobNumber !== undefined && { jobNumber }),
      });

    await expect(posting(userId, 1)).rejects.toThrow();
    await expect(posting(userId, 2)).resolves.toMatchObject({ jobNumber: 2 });
    await expect(posting(otherUserId, 1)).resolves.toMatchObject({ jobNumber: 1 });
    await expect(posting(userId)).resolves.toMatchObject({ jobNumber: null });
    await expect(posting(userId)).resolves.toMatchObject({ jobNumber: null });
  });

  it('leaves existing chats searching the whole library', async () => {
    const rows = await db.execute<{ title: string; source_ids: string[] | null }>(
      sql`select title, source_ids from chats where id = ${chatId}`,
    );

    expect(rows.rows).toEqual([{ title: 'Old chat', source_ids: null }]);
  });
});
