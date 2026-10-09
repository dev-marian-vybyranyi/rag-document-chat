import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { EMBEDDING_DIMENSIONS } from '../../src/db/schema.js';
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

  it('leaves existing chats searching the whole library', async () => {
    const rows = await db.execute<{ title: string; source_ids: string[] | null }>(
      sql`select title, source_ids from chats where id = ${chatId}`,
    );

    expect(rows.rows).toEqual([{ title: 'Old chat', source_ids: null }]);
  });
});
