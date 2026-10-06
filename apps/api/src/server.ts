import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './observability/logger.js';

const env = loadEnv();
const logger = createLogger(env);
const { db, pool } = createDb(env.DATABASE_URL);

await runMigrations(db);
logger.info('database migrations applied');

const app = createApp({ logger, db, cookieSecure: env.COOKIE_SECURE });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
