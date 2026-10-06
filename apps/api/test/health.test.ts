import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp({ logger: pino({ level: 'silent' }) });

describe('GET /health', () => {
  it('reports the service as ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('generates a request id when the client sends none', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes the request id sent by the client', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'trace-42');

    expect(res.headers['x-request-id']).toBe('trace-42');
  });
});
