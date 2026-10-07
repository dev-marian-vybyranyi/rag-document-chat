import { describe, expect, it } from 'vitest';
import { citedIds } from './citations';

describe('citedIds', () => {
  it('finds single, adjacent and comma-separated citations', () => {
    expect([...citedIds('A [1]. B [2][3]. C [4, 5].')]).toEqual([1, 2, 3, 4, 5]);
  });

  it('counts a number once however often it appears', () => {
    expect([...citedIds('A [1], B [1], C [1].')]).toEqual([1]);
  });

  it('ignores things that only look like citations', () => {
    expect(citedIds('values[x] and [a] and [123] and []').size).toBe(0);
  });

  it('finds nothing in text without citations', () => {
    expect(citedIds("I couldn't find this in your documents.").size).toBe(0);
  });
});
