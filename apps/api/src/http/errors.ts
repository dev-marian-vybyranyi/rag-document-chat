import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import type { ErrorCode } from './error-codes.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'not_found', 'Route not found'));
};

function requestIdOf(req: Request): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}

function errorBody(req: Request, code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, details, requestId: requestIdOf(req) } };
}

function fromParser(err: unknown): AppError | undefined {
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (type === 'entity.too.large') {
    return new AppError(413, 'payload_too_large', 'The request is too large');
  }
  if (type === 'entity.parse.failed') {
    return new AppError(400, 'invalid_json', 'The request body is not valid JSON');
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError(status, 'bad_request', 'Malformed request');
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const known = err instanceof AppError ? err : fromParser(err);
  if (known) {
    res.status(known.status).json(errorBody(req, known.code, known.message, known.details));
    return;
  }

  req.log.error({ err }, 'unhandled error');
  res.status(500).json(errorBody(req, 'internal_error', 'Internal server error'));
};
