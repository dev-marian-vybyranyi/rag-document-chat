import type { Logger } from 'pino';

interface ProcessLike {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (reason: unknown) => void): void;
}

export function installProcessErrorHandlers(
  logger: Logger,
  exit: (code: number) => void,
  target: ProcessLike = process,
) {
  let exiting = false;
  const fail = (event: string) => (reason: unknown) => {
    logger.fatal({ err: reason, event }, 'process error, shutting down');
    if (exiting) return;
    exiting = true;
    logger.flush();
    exit(1);
  };
  target.on('uncaughtException', fail('uncaughtException'));
  target.on('unhandledRejection', fail('unhandledRejection'));
}
