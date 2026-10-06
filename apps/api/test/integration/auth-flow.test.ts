import { eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sessions, users } from '../../src/db/schema.js';
import { buildTestApp, sessionCookie, tokenOf, useTestDb } from './helpers.js';

const ada = { email: 'ada@example.com', password: 'correct horse battery' };
const grace = { email: 'grace@example.com', password: 'another long passphrase' };

describe('auth flow', () => {
  const db = useTestDb();
  const app = buildTestApp(db);

  it('takes a user from sign-up through sign-out and back in', async () => {
    const browser = request.agent(app);

    expect((await browser.get('/auth/me')).status).toBe(401);

    expect((await browser.post('/auth/register').send(ada)).status).toBe(201);
    expect((await browser.get('/auth/me')).body.user.email).toBe(ada.email);

    expect((await browser.post('/auth/logout')).status).toBe(204);
    expect((await browser.get('/auth/me')).status).toBe(401);

    expect((await browser.post('/auth/login').send(ada)).status).toBe(200);
    expect((await browser.get('/auth/me')).body.user.email).toBe(ada.email);
  });

  it('keeps two users signed in at once without mixing them up', async () => {
    const adaBrowser = request.agent(app);
    const graceBrowser = request.agent(app);
    await adaBrowser.post('/auth/register').send(ada);
    await graceBrowser.post('/auth/register').send(grace);

    expect((await adaBrowser.get('/auth/me')).body.user.email).toBe(ada.email);
    expect((await graceBrowser.get('/auth/me')).body.user.email).toBe(grace.email);

    await adaBrowser.post('/auth/logout');
    expect((await adaBrowser.get('/auth/me')).status).toBe(401);
    expect((await graceBrowser.get('/auth/me')).status).toBe(200);
  });

  it('issues a fresh session on every sign-in and keeps a signed-out token dead', async () => {
    await request(app).post('/auth/register').send(ada);
    const first = tokenOf(sessionCookie(await request(app).post('/auth/login').send(ada))!);
    await request(app).post('/auth/logout').set('Cookie', `sid=${first}`);

    const second = tokenOf(sessionCookie(await request(app).post('/auth/login').send(ada))!);

    expect(second).not.toBe(first);
    expect((await request(app).get('/auth/me').set('Cookie', `sid=${first}`)).status).toBe(401);
    expect((await request(app).get('/auth/me').set('Cookie', `sid=${second}`)).status).toBe(200);
  });

  it('does not end the current session when another sign-in attempt fails', async () => {
    const browser = request.agent(app);
    await browser.post('/auth/register').send(ada);

    const failed = await browser.post('/auth/login').send({ ...ada, password: 'wrong-password' });

    expect(failed.status).toBe(401);
    expect((await browser.get('/auth/me')).status).toBe(200);
  });

  it('does not touch an existing session when a duplicate sign-up is refused', async () => {
    const browser = request.agent(app);
    await browser.post('/auth/register').send(ada);

    const duplicate = await request(app).post('/auth/register').send(ada);

    expect(duplicate.status).toBe(409);
    expect(sessionCookie(duplicate)).toBeUndefined();
    expect((await browser.get('/auth/me')).status).toBe(200);
  });

  it('signs a user out everywhere when the account is deleted', async () => {
    const browser = request.agent(app);
    const registered = await browser.post('/auth/register').send(ada);

    await db.delete(users).where(eq(users.id, registered.body.user.id));

    expect((await browser.get('/auth/me')).status).toBe(401);
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it('never exposes password material in any response of the flow', async () => {
    const browser = request.agent(app);
    const responses = [
      await browser.post('/auth/register').send(ada),
      await browser.get('/auth/me'),
      await browser.post('/auth/logout'),
      await browser.post('/auth/login').send(ada),
      await browser.post('/auth/login').send({ ...ada, password: 'wrong-password' }),
    ];

    for (const res of responses) {
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/passwordHash|password_hash|scrypt\$/);
      expect(body).not.toContain(ada.password);
    }
  });
});
