import express from 'express';
import type { Logger } from 'pino';
import { healthRouter } from './http/health.js';
import { requestLogger } from './http/request-logger.js';

interface AppDeps {
  logger: Logger;
}

/** Builds the Express app without starting a listener, so tests can mount it directly. */
export function createApp({ logger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.use(express.json());
  app.use(healthRouter);
  return app;
}
