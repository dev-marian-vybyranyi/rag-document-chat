import { createApp } from './app.js';
import {
  createChatModelFromEnv,
  createEmbedderFromEnv,
  createQueryRewriterFromEnv,
  createQuestionSuggesterFromEnv,
} from './ai/index.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createIngestionService, INTERRUPTED_MESSAGE } from './documents/ingest.js';
import { createDocumentRepository } from './documents/repository.js';
import { createRetriever } from './rag/retriever.js';
import { createRetrievalStore } from './rag/retrieval.js';
import { createLogger } from './observability/logger.js';
import { installProcessErrorHandlers } from './observability/process-errors.js';

const env = loadEnv();
const logger = createLogger(env);
installProcessErrorHandlers(logger, process.exit);
const { db, pool } = createDb(env.DATABASE_URL);

await runMigrations(db);
logger.info('database migrations applied');

if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
  logger.warn(
    'GOOGLE_GENERATIVE_AI_API_KEY is not set: documents cannot be indexed and chat cannot answer',
  );
}

const documentRepository = createDocumentRepository(db);
const interrupted = await documentRepository.failInterrupted(INTERRUPTED_MESSAGE);
if (interrupted > 0) logger.warn({ count: interrupted }, 'marked interrupted documents as failed');

const embedder = createEmbedderFromEnv(env);

const ingestion = createIngestionService({
  repository: documentRepository,
  embedder,
  logger,
  suggester: createQuestionSuggesterFromEnv(env, logger),
});

const app = createApp({
  logger,
  db,
  cookieSecure: env.COOKIE_SECURE,
  chatRateLimits: {
    perMinute: env.CHAT_RATE_LIMIT_PER_MINUTE,
    perDay: env.CHAT_RATE_LIMIT_PER_DAY,
  },
  ingestion,
  chat: {
    retriever: createRetriever({ store: createRetrievalStore(db), embedder, logger }),
    rewriter: createQueryRewriterFromEnv(env, logger),
    relevanceThreshold: env.RELEVANCE_THRESHOLD,
    ...createChatModelFromEnv(env),
  },
});

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
