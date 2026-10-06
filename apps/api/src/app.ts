import express from 'express';
import type { Logger } from 'pino';
import { createAuthRouter } from './auth/routes.js';
import { createUserRepository } from './auth/users.js';
import type { Database } from './db/client.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { healthRouter } from './http/health.js';
import { requestLogger } from './http/request-logger.js';

interface AppDeps {
  logger: Logger;
  db: Database;
}

/** Builds the Express app without starting a listener, so tests can mount it directly. */
export function createApp({ logger, db }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.use(express.json());

  app.use(healthRouter);
  app.use('/auth', createAuthRouter(createUserRepository(db)));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
