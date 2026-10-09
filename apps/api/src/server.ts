import { createApp } from './app.js';
import { createAiProvider } from './ai/index.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createIngestionService, INTERRUPTED_MESSAGE } from './documents/ingest.js';
import { createDocumentRepository } from './documents/repository.js';
import { defaultImportLimits } from './repositories/filter.js';
import { createGithubImporter } from './repositories/github.js';
import { createRepositoryIngestion } from './repositories/ingest.js';
import { relevanceThresholds } from './rag/relevance.js';
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

const ai = createAiProvider(env);
if (!ai.configured) {
  logger.warn(`${ai.keyVariable} is not set: documents cannot be indexed and chat cannot answer`);
}

const documentRepository = createDocumentRepository(db);
const interrupted = await documentRepository.failInterrupted(INTERRUPTED_MESSAGE);
if (interrupted > 0) logger.warn({ count: interrupted }, 'marked interrupted documents as failed');

const embedder = ai.embedder;

const otherModel = await documentRepository.countIndexedWithOtherModel(env.EMBEDDING_MODEL);
if (otherModel > 0) {
  logger.warn(
    { count: otherModel, embeddingModel: env.EMBEDDING_MODEL },
    'documents were indexed with a different embedding model and are not searched; upload them again',
  );
}

const ingestion = createIngestionService({
  repository: documentRepository,
  embedder,
  logger,
  suggester: ai.createSuggester(logger),
  embeddingModel: env.EMBEDDING_MODEL,
});

const importLimits = { ...defaultImportLimits, maxFiles: env.REPOSITORY_MAX_FILES };
const repositoryIngestion = createRepositoryIngestion({
  repository: documentRepository,
  embedder,
  github: createGithubImporter({ token: env.GITHUB_TOKEN, limits: importLimits }),
  logger,
  embeddingModel: env.EMBEDDING_MODEL,
  limits: importLimits,
  maxChunks: env.REPOSITORY_MAX_CHUNKS,
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
  repositoryIngestion,
  chat: {
    retriever: createRetriever({
      store: createRetrievalStore(db, { embeddingModel: env.EMBEDDING_MODEL }),
      embedder,
      logger,
    }),
    rewriter: ai.createRewriter(logger),
    relevanceThreshold: relevanceThresholds(env),
    ...ai.chat,
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
