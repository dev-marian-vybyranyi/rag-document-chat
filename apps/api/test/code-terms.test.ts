import { describe, expect, it } from 'vitest';
import { codeSearchTerms, toTsQueryOr } from '../src/rag/code-terms.js';

describe('codeSearchTerms', () => {
  it('keeps an identifier whole and also splits it into its words', () => {
    expect(codeSearchTerms('createAuthRouter')).toEqual([
      'createauthrouter',
      'create',
      'auth',
      'router',
    ]);
  });

  it.each([
    ['snake_case_name', ['snake', 'case', 'name']],
    ['HTTPServer', ['httpserver', 'http', 'server']],
    ['parseURLFast', ['parseurlfast', 'parse', 'url', 'fast']],
    ['MAX_ATTEMPTS', ['max', 'attempts']],
    ['getUserById2', ['getuserbyid2', 'get', 'user', 'id2']],
  ])('splits %s', (word, expected) => {
    const terms = codeSearchTerms(word);

    for (const part of expected) {
      if (part.length >= 2) expect(terms).toContain(part);
    }
  });

  it('drops the words of an ordinary question', () => {
    expect(codeSearchTerms('Where is the login handler implemented?')).toEqual([
      'login',
      'handler',
    ]);
  });

  it('splits file paths into their parts', () => {
    expect(codeSearchTerms('src/auth/routes.ts')).toEqual(['src', 'auth', 'routes', 'ts']);
  });

  it('lowercases, removes duplicates and ignores one-letter pieces', () => {
    expect(codeSearchTerms('Auth auth AUTH x y')).toEqual(['auth']);
  });

  it('produces nothing for a question that is only filler', () => {
    expect(codeSearchTerms('what is this?')).toEqual([]);
    expect(codeSearchTerms('')).toEqual([]);
  });

  it('is limited in length', () => {
    const many = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');

    expect(codeSearchTerms(many)).toHaveLength(24);
  });

  it('only ever yields letters and digits, so it cannot carry query syntax', () => {
    const terms = codeSearchTerms(`foo' | bar & !baz:* (qux) <-> "x" ; drop table`);

    for (const term of terms) expect(term).toMatch(/^[a-z0-9]+$/);
  });
});

describe('toTsQueryOr', () => {
  it('joins the terms with OR', () => {
    expect(toTsQueryOr(['login', 'handler'])).toBe('login | handler');
  });
});
