import { describe, expect, it } from 'vitest';
import { cleanSpeakerName, createSpeakerRegistry } from '../src/meetings/speakers.js';
import { formatTimestamp, parseTimestamp } from '../src/meetings/timestamp.js';

describe('parseTimestamp', () => {
  it.each([
    ['00:00:05', 5000],
    ['12:34', 754_000],
    ['1:02:03', 3_723_000],
    ['1:02:03.5', 3_723_500],
    ['00:00:05,250', 5250],
    ['00:00:05.05', 5050],
    ['99:59', 99 * 60_000 + 59_000],
    ['125:30', 125 * 60_000 + 30_000],
  ])('reads %s', (value, expected) => {
    expect(parseTimestamp(value)).toBe(expected);
  });

  it.each([
    '',
    '12',
    'ab:cd',
    '1:75',
    '1:02:75',
    '1:60:00',
    '1234:00',
    '00:00:05.1234',
    '5.5',
    ' 1:05',
  ])('rejects %j', (value) => {
    expect(parseTimestamp(value)).toBeNull();
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00:00'],
    [999, '00:00:00'],
    [1000, '00:00:01'],
    [3_723_500, '01:02:03'],
    [100 * 3_600_000, '100:00:00'],
    [-5000, '00:00:00'],
  ])('shows %i ms as %s', (ms, expected) => {
    expect(formatTimestamp(ms)).toBe(expected);
  });

  it('reads back what it wrote, to the second', () => {
    for (const ms of [0, 5000, 61_000, 3_599_000, 3_600_000, 7_325_000]) {
      expect(parseTimestamp(formatTimestamp(ms))).toBe(ms);
    }
  });
});

describe('cleanSpeakerName', () => {
  it('collapses whitespace', () => {
    expect(cleanSpeakerName('  Alice   Smith ')).toBe('Alice Smith');
  });

  it('removes invisible characters that could disguise a name', () => {
    expect(cleanSpeakerName('Al​ice‮')).toBe('Alice');
  });

  it.each(['Dr. Smith', "Mary-Jane O'Neil", 'Speaker 1', 'Оксана'])('keeps %s', (name) => {
    expect(cleanSpeakerName(name)).toBe(name);
  });

  it.each(['', '   ', '12:30', '---', 'x'.repeat(61), 'a b c d e f g'])('refuses %j', (name) => {
    expect(cleanSpeakerName(name)).toBeNull();
  });

  it('is stricter for a name that stands alone on a line, since any short line could be one', () => {
    expect(cleanSpeakerName('a b c d e')).toBe('a b c d e');
    expect(cleanSpeakerName('a b c d e', { header: true })).toBeNull();
    expect(cleanSpeakerName('Hello there.')).toBe('Hello there.');
    expect(cleanSpeakerName('Hello there.', { header: true })).toBeNull();
    expect(cleanSpeakerName('Who?', { header: true })).toBeNull();
  });
});

describe('speaker registry', () => {
  it('treats names that differ only in case as one person and keeps the first spelling', () => {
    const registry = createSpeakerRegistry();

    expect(registry.canonical('alice')).toBe('alice');
    expect(registry.canonical('Alice')).toBe('alice');
    expect(registry.canonical('ALICE')).toBe('alice');
    expect(registry.canonical('Bob')).toBe('Bob');
    expect(registry.names()).toEqual(['alice', 'Bob']);
  });

  it('keeps people with similar names apart', () => {
    const registry = createSpeakerRegistry();

    registry.canonical('Alice');
    registry.canonical('Alicia');
    registry.canonical('Alice B');

    expect(registry.names()).toEqual(['Alice', 'Alicia', 'Alice B']);
  });
});
