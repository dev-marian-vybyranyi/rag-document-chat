import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthRateLimits } from '../../src/http/rate-limit.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

describe('auth rate limiting', () => {
  const db = useTestDb();

  const limits = (overrides: Partial<AuthRateLimits> = {}): AuthRateLimits => ({
    maxFailedLogins: 3,
    failedLoginWindowMs: 60_000,
    maxRequests: 1_000,
    overallWindowMs: 60_000,
    ...overrides,
  });

  async function appWithAccount(overrides?: Partial<AuthRateLimits>) {
    const app = buildTestApp(db, { authRateLimits: limits(overrides) });
    await request(app).post('/auth/register').send(credentials);
    return app;
  }

  const wrongLogin = (app: ReturnType<typeof buildTestApp>, email = credentials.email) =>
    request(app).post('/auth/login').send({ email, password: 'wrong-password' });

  describe('failed sign-ins', () => {
    it('lock an account after too many failures, even for the right password', async () => {
      const app = await appWithAccount();
      for (let i = 0; i < 3; i++) expect((await wrongLogin(app)).status).toBe(401);

      const blocked = await request(app).post('/auth/login').send(credentials);

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('are counted per account, so other accounts are unaffected', async () => {
      const app = await appWithAccount();
      for (let i = 0; i < 4; i++) await wrongLogin(app);

      const other = await wrongLogin(app, 'someone-else@example.com');

      expect(other.status).toBe(401);
    });

    it('cannot dodge the limit by changing the letter case of the email', async () => {
      const app = await appWithAccount();
      for (const email of ['ada@example.com', 'ADA@example.com', ' Ada@Example.com ']) {
        await wrongLogin(app, email);
      }

      const blocked = await wrongLogin(app, 'aDa@EXAMPLE.com');

      expect(blocked.status).toBe(429);
    });

    it('are the only thing counted: successful sign-ins never trip the limit', async () => {
      const app = await appWithAccount({ maxFailedLogins: 2 });

      for (let i = 0; i < 6; i++) {
        expect((await request(app).post('/auth/login').send(credentials)).status).toBe(200);
      }
    });

    it('are forgotten after a correct password', async () => {
      const app = await appWithAccount();
      await wrongLogin(app);
      await wrongLogin(app);
      expect((await request(app).post('/auth/login').send(credentials)).status).toBe(200);

      await wrongLogin(app);
      await wrongLogin(app);

      expect((await wrongLogin(app)).status).toBe(401);
    });
  });

  describe('overall ceiling', () => {
    const signIn = (app: ReturnType<typeof buildTestApp>) =>
      request(app).post('/auth/login').send(credentials);

    it('rejects sign-ins and registrations beyond the limit but leaves other routes alone', async () => {
      const app = buildTestApp(db, { authRateLimits: limits({ maxRequests: 3 }) });
      for (let i = 0; i < 3; i++) await signIn(app);

      const login = await signIn(app);
      const register = await request(app).post('/auth/register').send(credentials);
      const health = await request(app).get('/health');

      expect(login.status).toBe(429);
      expect(login.body.error.code).toBe('rate_limited');
      expect(register.status).toBe(429);
      expect(health.status).toBe(200);
    });

    it('does not stop signed-in users from loading the app or signing out once it is spent', async () => {
      const app = buildTestApp(db, { authRateLimits: limits({ maxRequests: 2 }) });
      const agent = request.agent(app);
      expect((await agent.post('/auth/register').send(credentials)).status).toBe(201);
      await signIn(app);
      expect((await signIn(app)).status).toBe(429);

      for (let i = 0; i < 5; i++) expect((await agent.get('/auth/me')).status).toBe(200);
      expect((await request(app).get('/auth/me')).status).toBe(401);
      expect((await agent.post('/auth/logout')).status).toBe(204);
    });

    it('does not depend on the client address, so X-Forwarded-For cannot change the outcome', async () => {
      const app = buildTestApp(db, { authRateLimits: limits({ maxRequests: 2 }) });

      await signIn(app).set('X-Forwarded-For', '1.1.1.1');
      await signIn(app).set('X-Forwarded-For', '2.2.2.2');
      const blocked = await signIn(app).set('X-Forwarded-For', '3.3.3.3');

      expect(blocked.status).toBe(429);
    });
  });
});
