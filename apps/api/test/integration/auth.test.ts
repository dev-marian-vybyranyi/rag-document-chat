import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { buildTestApp, useTestDb } from './helpers.js';

describe('auth endpoints', () => {
  const db = useTestDb();
  const app = buildTestApp(db);

  const credentials = { email: 'ada@example.com', password: 'correct horse battery' };
  const register = (body: object = credentials) => request(app).post('/auth/register').send(body);
  const login = (body: object = credentials) => request(app).post('/auth/login').send(body);

  describe('POST /auth/register', () => {
    it('creates the account and returns the public user', async () => {
      const res = await register();

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ user: { id: expect.any(String), email: 'ada@example.com' } });
    });

    it('stores a hash of the password, never the password itself', async () => {
      await register();

      const [stored] = await db.select().from(users);
      expect(stored?.passwordHash).toMatch(/^scrypt\$/);
      expect(stored?.passwordHash).not.toContain(credentials.password);
    });

    it('rejects an invalid email with field-level details', async () => {
      const res = await register({ ...credentials, email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
      expect(res.body.error.details.email).toHaveLength(1);
    });

    it('rejects a password shorter than 8 characters', async () => {
      const res = await register({ ...credentials, password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.error.details.password).toHaveLength(1);
    });

    it('rejects a missing body', async () => {
      const res = await request(app).post('/auth/register');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });

    it('rejects malformed JSON', async () => {
      const res = await request(app)
        .post('/auth/register')
        .set('content-type', 'application/json')
        .send('{"email":');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    });

    it('answers 409 when the email is already registered, ignoring letter case', async () => {
      await register();

      const res = await register({ ...credentials, email: 'ADA@example.com' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('email_taken');
    });
  });

  describe('POST /auth/login', () => {
    it('accepts the registered credentials, ignoring email letter case', async () => {
      await register();

      const res = await login({ ...credentials, email: 'Ada@Example.com' });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('ada@example.com');
      expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    it('answers 401 for a wrong password', async () => {
      await register();

      const res = await login({ ...credentials, password: 'wrong-password' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_credentials');
    });

    it('gives an unknown email the same response as a wrong password', async () => {
      await register();
      const wrongPassword = await login({ ...credentials, password: 'wrong-password' });

      const unknownEmail = await login({ ...credentials, email: 'nobody@example.com' });

      expect(unknownEmail.status).toBe(wrongPassword.status);
      expect(unknownEmail.body).toEqual(wrongPassword.body);
    });

    it('rejects a request without a password', async () => {
      const res = await login({ email: credentials.email });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    });
  });

  it('answers unknown routes with the JSON error shape', async () => {
    const res = await request(app).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
