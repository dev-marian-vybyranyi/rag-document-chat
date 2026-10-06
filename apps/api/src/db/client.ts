import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type Database = ReturnType<typeof createDb>['db'];

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, casing: 'snake_case' });
  return { db, pool };
}
