import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import { AppError } from '../http/errors.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const megabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

export const MAX_PENDING_UPLOADS = {
  documents: 8,
  repositories: 4,
  career: 8,
  meetings: 8,
} as const;

export function requireQueueRoom(queue: { pending(): number }, max: number): void {
  if (queue.pending() >= max) {
    throw new AppError(
      503,
      'ai_busy',
      'Other files are still being processed. Try again in a few minutes.',
    );
  }
}

const MAX_FIELD_BYTES = 1024;

export function singleFileUpload(
  maxBytes: number,
  options: { textFields?: number } = {},
): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: options.textFields ?? 0,
      fieldSize: MAX_FIELD_BYTES,
    },
    defParamCharset: 'utf8',
  }).single('file');

  return (req, res, next) => {
    parse(req, res, (error: unknown) => {
      if (!(error instanceof MulterError)) return next(error);

      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(
          new AppError(
            413,
            'file_too_large',
            `The file is too large (limit ${megabytes(maxBytes)} MB)`,
          ),
        );
      }
      next(new AppError(400, 'invalid_upload', 'Send exactly one file in the "file" field'));
    });
  };
}
