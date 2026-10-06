import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const DEFAULT_URL = 'postgres://postgres:postgres@localhost:5432/ragchat_test';

export default async function setup(project: TestProject) {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const { pathname } = new URL(url);
  const dbName = pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`TEST_DATABASE_URL has an unsupported database name: "${dbName}"`);
  }

  await ensureDatabase(url, dbName);

  const { db, pool } = createDb(url);
  try {
    await runMigrations(db);
  } finally {
    await pool.end();
  }

  project.provide('testDatabaseUrl', url);
}

async function ensureDatabase(url: string, dbName: string) {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (cause) {
    throw new Error(
      'Integration tests need a running Postgres with pgvector. Start one with ' +
        '`docker compose up -d db`, or point TEST_DATABASE_URL at your own instance.',
      { cause },
    );
  }
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
    if (exists.rowCount === 0) await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}
