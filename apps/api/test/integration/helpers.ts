import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, inject } from 'vitest';
import { createDb } from '../../src/db/client.js';

export function useTestDb() {
  const { db, pool } = createDb(inject('testDatabaseUrl'));

  beforeEach(async () => {
    const tables = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    if (tables.rows.length === 0) return;
    const names = tables.rows.map((t) => `"${t.tablename}"`).join(', ');
    await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  });

  afterAll(async () => {
    await pool.end();
  });

  return db;
}

export function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code;
}
