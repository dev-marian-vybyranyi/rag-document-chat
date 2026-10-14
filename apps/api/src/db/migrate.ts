import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Database } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Database): Promise<void> {
  await db.execute(sql`create schema if not exists "drizzle"`);
  await db.execute(sql`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
  const last = await db.execute<{ created_at: string | null }>(
    sql`select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`,
  );
  const lastApplied = last.rows[0]?.created_at;

  for (const migration of readMigrationFiles({ migrationsFolder })) {
    if (lastApplied && Number(lastApplied) >= migration.folderMillis) continue;
    await db.transaction(async (tx) => {
      for (const statement of migration.sql) await tx.execute(sql.raw(statement));
      await tx.execute(
        sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values (${migration.hash}, ${migration.folderMillis})`,
      );
    });
  }
}
