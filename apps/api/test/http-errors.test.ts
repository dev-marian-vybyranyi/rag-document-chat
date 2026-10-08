import express from 'express';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '../src/http/error-codes.js';
import { AppError, errorHandler, notFoundHandler } from '../src/http/errors.js';
import { requestLogger } from '../src/http/request-logger.js';
import { installProcessErrorHandlers } from '../src/observability/process-errors.js';

function buildApp() {
  const app = express();
  app.use(requestLogger(pino({ level: 'silent' })));
  app.use(express.json());
  app.get('/app-error', () => {
    throw new AppError(409, 'chat_full', 'This conversation is full', { limit: 200 });
  });
  app.get('/busy', () => {
    throw new AppError(503, 'ai_busy', 'Try later', undefined, 42);
  });
  app.get('/boom', () => {
    throw new Error('secret internal detail at /srv/app/db.ts');
  });
  app.get('/async-boom', async () => {
    throw new Error('secret async detail');
  });
  app.get('/teapot', (_req, _res, next) => {
    next(Object.assign(new Error('library says no'), { status: 418 }));
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('error responses', () => {
  const app = buildApp();

  it('have one shape: a code, a message, details only when there are some, and the request id', async () => {
    const res = await request(app).get('/app-error');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'chat_full',
        message: 'This conversation is full',
        details: { limit: 200 },
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('carry the id the caller sent, so a report can be matched to the log line', async () => {
    const res = await request(app).get('/app-error').set('X-Request-Id', 'req-from-client-1');

    expect(res.body.error.requestId).toBe('req-from-client-1');
    expect(res.headers['x-request-id']).toBe('req-from-client-1');
  });

  it('tell the caller when to come back, when the error has a wait', async () => {
    const busy = await request(app).get('/busy');
    const full = await request(app).get('/app-error');

    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('42');
    expect(full.headers['retry-after']).toBeUndefined();
  });

  it('are JSON for an unknown route too', async () => {
    const res = await request(app).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Route not found' });
    expect(res.body.error.details).toBeUndefined();
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  describe('for a request body that cannot be read', () => {
    it('say the JSON is invalid without echoing the parser message', async () => {
      const res = await request(app)
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send('{"a": nope');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'invalid_json',
        message: 'The request body is not valid JSON',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|position|token/i);
    });

    it('say the request is too large, with the right status', async () => {
      const res = await request(app)
        .post('/echo')
        .send({ text: 'x'.repeat(200 * 1024) });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('payload_too_large');
    });
  });

  it('keep the status of a client error raised by a library, under a generic code', async () => {
    const res = await request(app).get('/teapot');

    expect(res.status).toBe(418);
    expect(res.body.error).toMatchObject({ code: 'bad_request', message: 'Malformed request' });
  });

  it.each(['/boom', '/async-boom'])(
    'hide the cause of an unexpected failure at %s, but not the request id',
    async (path) => {
      const res = await request(app).get(path);

      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
        requestId: res.headers['x-request-id'],
      });
      expect(JSON.stringify(res.body)).not.toContain('secret');
    },
  );
});

describe('error codes', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });

  const usedCodes = new Set(
    sourceFiles(join(import.meta.dirname, '../src')).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const found = [
        ...text.matchAll(/new AppError\(\s*[\w.]+,\s*'([a-z_]+)'/g),
        ...text.matchAll(/errorBody\(req,\s*'([a-z_]+)'/g),
      ];
      return found.map((match) => match[1]!);
    }),
  );

  it('are all listed in the registry, which the clients and the docs rely on', () => {
    expect(usedCodes.size).toBeGreaterThan(10);
    for (const code of usedCodes) expect(ERROR_CODES).toContain(code);
  });

  it('are all used somewhere, so the registry holds no dead entries', () => {
    for (const code of ERROR_CODES) expect(usedCodes).toContain(code);
  });

  it('are lower snake case and unique', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});

describe('installProcessErrorHandlers', () => {
  function setup() {
    const listeners = new Map<string, (reason: unknown) => void>();
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
      },
    );
    const exit = vi.fn();
    installProcessErrorHandlers(logger, exit, {
      on: (event, listener) => void listeners.set(event, listener),
    });
    return { listeners, lines, exit };
  }

  it.each(['uncaughtException', 'unhandledRejection'])(
    'log %s as a fatal structured line and exit with a failure code',
    (event) => {
      const { listeners, lines, exit } = setup();

      listeners.get(event)!(new Error('lost promise'));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 60, event, msg: 'process error, shutting down' });
      expect((lines[0]!.err as { message: string }).message).toBe('lost promise');
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

  it('exit only once when several errors follow each other', () => {
    const { listeners, lines, exit } = setup();

    listeners.get('unhandledRejection')!(new Error('first'));
    listeners.get('uncaughtException')!(new Error('second'));

    expect(lines).toHaveLength(2);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
