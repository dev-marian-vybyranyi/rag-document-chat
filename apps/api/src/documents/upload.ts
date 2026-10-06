import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import { AppError } from '../http/errors.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const megabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

export function singleFileUpload(maxBytes: number): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 0 },
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
