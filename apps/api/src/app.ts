import cookieParser from 'cookie-parser';
import express from 'express';
import type { Logger } from 'pino';
import { loadSession } from './auth/middleware.js';
import { createAuthRouter } from './auth/routes.js';
import { createSessionRepository } from './auth/sessions.js';
import { createUserRepository } from './auth/users.js';
import { createPassthroughRewriter } from './rag/rewrite.js';
import { createChatRepository } from './chat/repository.js';
import { createChatResponder, type ChatDeps } from './chat/responder.js';
import { createChatsRouter } from './chat/routes.js';
import type { Database } from './db/client.js';
import { createDocumentRepository } from './documents/repository.js';
import { createDocumentsRouter } from './documents/routes.js';
import type { IngestionService } from './documents/ingest.js';
import { DEFAULT_MAX_UPLOAD_BYTES } from './documents/upload.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { healthRouter } from './http/health.js';
import { defaultUsageLimits, type UsageLimits } from './http/limits.js';
import {
  createAuthRateLimiters,
  createChatRateLimiters,
  createUploadRateLimiter,
  defaultAuthRateLimits,
  defaultChatRateLimits,
  defaultUploadRateLimit,
  type AuthRateLimits,
  type ChatRateLimits,
  type UploadRateLimit,
} from './http/rate-limit.js';
import { requestLogger } from './http/request-logger.js';
import { createTraceRecorder } from './observability/traces.js';

const unavailableChat: ChatDeps = {
  retriever: { retrieve: async () => ({ chunks: [], mode: 'hybrid' }) },
  rewriter: createPassthroughRewriter(),
  model: null,
};

interface AppDeps {
  logger: Logger;
  db: Database;
  cookieSecure: boolean;
  ingestion: IngestionService;
  chat?: ChatDeps;
  authRateLimits?: AuthRateLimits;
  chatRateLimits?: ChatRateLimits;
  uploadRateLimit?: UploadRateLimit;
  usageLimits?: UsageLimits;
  maxUploadBytes?: number;
}

export function createApp({
  logger,
  db,
  cookieSecure,
  ingestion,
  chat,
  authRateLimits = defaultAuthRateLimits,
  chatRateLimits = defaultChatRateLimits,
  uploadRateLimit = defaultUploadRateLimit,
  usageLimits = defaultUsageLimits,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
}: AppDeps) {
  const users = createUserRepository(db);
  const sessions = createSessionRepository(db);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.use(express.json());
  app.use(cookieParser());
  app.use(loadSession(sessions));

  app.use(healthRouter);
  app.use(
    '/auth',
    createAuthRouter({
      users,
      sessions,
      cookieSecure,
      limiters: createAuthRateLimiters(authRateLimits),
    }),
  );

  app.use(
    '/documents',
    createDocumentsRouter({
      documents: createDocumentRepository(db),
      ingestion,
      maxUploadBytes,
      maxDocumentsPerUser: usageLimits.maxDocumentsPerUser,
      uploadLimiter: createUploadRateLimiter(uploadRateLimit),
    }),
  );

  const chats = createChatRepository(db);
  app.use(
    '/chats',
    createChatsRouter({
      chats,
      responder: createChatResponder(
        chats,
        { maxMessagesPerChat: usageLimits.maxMessagesPerChat, ...(chat ?? unavailableChat) },
        logger,
        createTraceRecorder(db, logger),
      ),
      questionLimiters: createChatRateLimiters(chatRateLimits),
      maxChatsPerUser: usageLimits.maxChatsPerUser,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
