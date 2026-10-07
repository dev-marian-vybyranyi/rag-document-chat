import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadEnv', () => {
  it('applies defaults for everything optional', () => {
    const env = loadEnv(base);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      EMBEDDING_MODEL: 'gemini-embedding-001',
      CHAT_MODEL: 'gemini-3.5-flash-lite',
      CHAT_THINKING_LEVEL: 'minimal',
      COOKIE_SECURE: false,
    });
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });

  it('requires a database url and explains what is wrong', () => {
    expect(() => loadEnv({})).toThrow(/Invalid environment configuration[\s\S]*DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });

  it('turns the session cookie to HTTPS-only in production unless told otherwise', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(
      false,
    );
  });

  describe('GOOGLE_GENERATIVE_AI_API_KEY', () => {
    it('is passed through when set', () => {
      expect(loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: 'abc123' })).toMatchObject({
        GOOGLE_GENERATIVE_AI_API_KEY: 'abc123',
      });
    });

    it.each(['', '   '])('counts %j as not set, as left by a blank .env line', (blank) => {
      const env = loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: blank });

      expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    });

    it('is trimmed, since pasted keys often carry a trailing newline', () => {
      const env = loadEnv({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: ' abc123\n' });

      expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('abc123');
    });
  });

  it('lets the embedding model be switched', () => {
    expect(loadEnv({ ...base, EMBEDDING_MODEL: 'gemini-embedding-2' }).EMBEDDING_MODEL).toBe(
      'gemini-embedding-2',
    );
  });

  it('only accepts a thinking level the model API knows', () => {
    expect(loadEnv({ ...base, CHAT_THINKING_LEVEL: 'low' }).CHAT_THINKING_LEVEL).toBe('low');
    expect(() => loadEnv({ ...base, CHAT_THINKING_LEVEL: 'extreme' })).toThrow(
      /CHAT_THINKING_LEVEL/,
    );
  });
});
