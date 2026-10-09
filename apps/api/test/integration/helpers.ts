import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import type { Response } from 'supertest';
import { afterAll, beforeEach, inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDb, type Database } from '../../src/db/client.js';
import type { ChatDeps } from '../../src/chat/responder.js';
import type { IngestionService } from '../../src/documents/ingest.js';
import type { RepositoryIngestionService } from '../../src/repositories/ingest.js';
import type { UsageLimits } from '../../src/http/limits.js';
import type { AuthRateLimits, ChatRateLimits, UploadRateLimit } from '../../src/http/rate-limit.js';
import { createInertIngestion } from '../helpers/ingestion.js';

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

const generousLimits: AuthRateLimits = {
  maxFailedLogins: 1_000,
  failedLoginWindowMs: 60_000,
  maxRequests: 10_000,
  overallWindowMs: 60_000,
};

export function buildTestApp(
  db: Database,
  overrides: {
    cookieSecure?: boolean;
    authRateLimits?: AuthRateLimits;
    maxUploadBytes?: number;
    ingestion?: IngestionService;
    repositoryIngestion?: RepositoryIngestionService;
    maxArchiveBytes?: number;
    chat?: ChatDeps;
    chatRateLimits?: ChatRateLimits;
    uploadRateLimit?: UploadRateLimit;
    usageLimits?: UsageLimits;
  } = {},
) {
  return createApp({
    logger: pino({ level: 'silent' }),
    db,
    cookieSecure: false,
    authRateLimits: generousLimits,
    chatRateLimits: { perMinute: 10_000, perDay: 100_000 },
    uploadRateLimit: { perHour: 10_000 },
    ingestion: createInertIngestion(),
    ...overrides,
  });
}

export function sessionCookie(res: Response): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  return [header ?? []].flat().find((c) => c.startsWith('sid='));
}

export function tokenOf(cookie: string): string {
  return cookie.split(';')[0]!.slice('sid='.length);
}

export function withoutRequestId(body: { error: Record<string, unknown> }) {
  return { error: { ...body.error, requestId: undefined } };
}
