import { z } from 'zod';
import { AppError } from './errors.js';

export function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  return parseBody(schema, query);
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      'validation_error',
      'Request validation failed',
      z.flattenError(result.error).fieldErrors,
    );
  }
  return result.data;
}
