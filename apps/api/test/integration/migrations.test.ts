import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { useTestDb } from './helpers.js';

describe('migrations', () => {
  const db = useTestDb();

  it('enable the pgvector extension', async () => {
    const result = await db.execute(sql`select 1 from pg_extension where extname = 'vector'`);

    expect(result.rowCount).toBe(1);
  });

  it('create the users and sessions tables', async () => {
    const result = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );

    expect(result.rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining(['sessions', 'users']),
    );
  });

  it('can be applied again without error', async () => {
    await expect(runMigrations(db)).resolves.toBeUndefined();
  });
});
