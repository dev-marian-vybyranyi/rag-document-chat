import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashToken, SESSION_TTL_MS } from '../../src/auth/sessions.js';
import { sessions } from '../../src/db/schema.js';
import { buildTestApp, useTestDb } from './helpers.js';

const credentials = { email: 'ada@example.com', password: 'correct horse battery' };

function sessionCookie(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  return [header ?? []].flat().find((c) => c.startsWith('sid='));
}

const tokenOf = (cookie: string) => cookie.split(';')[0]!.slice('sid='.length);

describe('sessions', () => {
  const db = useTestDb();
  const app = buildTestApp(db);

  const register = () => request(app).post('/auth/register').send(credentials);
  const login = () => request(app).post('/auth/login').send(credentials);

  describe('cookie', () => {
    it('is set on registration and on login', async () => {
      const registered = await register();
      const loggedIn = await login();

      expect(sessionCookie(registered)).toBeDefined();
      expect(sessionCookie(loggedIn)).toBeDefined();
    });

    it('is httpOnly, SameSite=Lax and expires with the session', async () => {
      const cookie = sessionCookie(await register())!;

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      const expires = new Date(/Expires=([^;]+)/.exec(cookie)![1]!).getTime();
      expect(expires).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    });

    it('is Secure only when configured for HTTPS', async () => {
      const secureApp = buildTestApp(db, { cookieSecure: true });

      const overHttps = await request(secureApp).post('/auth/register').send(credentials);
      const overHttp = await request(app)
        .post('/auth/register')
        .send({ ...credentials, email: 'grace@example.com' });

      expect(sessionCookie(overHttps)).toContain('Secure');
      expect(sessionCookie(overHttp)).not.toContain('Secure');
    });

    it('is not set when credentials are wrong', async () => {
      await register();

      const res = await request(app)
        .post('/auth/login')
        .send({ ...credentials, password: 'wrong-password' });

      expect(sessionCookie(res)).toBeUndefined();
    });
  });

  describe('GET /auth/me', () => {
    it('returns the signed-in user', async () => {
      const agent = request.agent(app);
      await agent.post('/auth/register').send(credentials);

      const res = await agent.get('/auth/me');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ user: { id: expect.any(String), email: 'ada@example.com' } });
    });

    it('answers 401 without a cookie', async () => {
      const res = await request(app).get('/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('answers 401 for a token that was never issued', async () => {
      const res = await request(app).get('/auth/me').set('Cookie', 'sid=forged-token');

      expect(res.status).toBe(401);
    });

    it('answers 401 once the session has expired', async () => {
      const agent = request.agent(app);
      await agent.post('/auth/register').send(credentials);
      await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });

      const res = await agent.get('/auth/me');

      expect(res.status).toBe(401);
    });
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const token = tokenOf(sessionCookie(await register())!);

    const [stored] = await db.select().from(sessions);

    expect(stored?.id).toBe(hashToken(token));
    expect(stored?.id).not.toBe(token);
  });

  describe('POST /auth/logout', () => {
    it('ends the session and clears the cookie', async () => {
      const cookie = sessionCookie(await register())!;
      const token = tokenOf(cookie);

      const res = await request(app).post('/auth/logout').set('Cookie', `sid=${token}`);

      expect(res.status).toBe(204);
      expect(sessionCookie(res)).toMatch(/^sid=;/);
      expect(
        await db
          .select()
          .from(sessions)
          .where(eq(sessions.id, hashToken(token))),
      ).toEqual([]);
      const afterLogout = await request(app).get('/auth/me').set('Cookie', `sid=${token}`);
      expect(afterLogout.status).toBe(401);
    });

    it('only ends the session it was called with', async () => {
      await register();
      const first = tokenOf(sessionCookie(await login())!);
      const second = tokenOf(sessionCookie(await login())!);

      await request(app).post('/auth/logout').set('Cookie', `sid=${first}`);

      const stillValid = await request(app).get('/auth/me').set('Cookie', `sid=${second}`);
      expect(stillValid.status).toBe(200);
    });

    it('succeeds even when nobody is signed in', async () => {
      const res = await request(app).post('/auth/logout');

      expect(res.status).toBe(204);
    });
  });

  it('removes expired sessions when a new one is created', async () => {
    await register();
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });

    await login();

    expect(await db.select().from(sessions)).toHaveLength(1);
  });
});
