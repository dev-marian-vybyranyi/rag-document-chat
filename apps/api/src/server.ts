import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './observability/logger.js';

const env = loadEnv();
const logger = createLogger(env);
const app = createApp({ logger });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}
