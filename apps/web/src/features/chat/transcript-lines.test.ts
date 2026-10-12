import { describe, expect, it } from 'vitest';
import { speakerTone, spokenLines, transcriptRows } from './transcript-lines';

const passage = (ordinal: number, ...lines: string[]) => ({
  ordinal,
  content: ['Meeting: Release sync (2026-10-01)', ...lines].join('\n'),
});

describe('spokenLines', () => {
  it('reads the time, the speaker and the words of each line, and skips the title', () => {
    expect(
      spokenLines(
        'Meeting: Release sync\n[00:00:05] Alice: Morning.\n[01:02:03] Dr. Smith: Note: this matters.',
      ),
    ).toEqual([
      { time: '00:00:05', speaker: 'Alice', text: 'Morning.' },
      { time: '01:02:03', speaker: 'Dr. Smith', text: 'Note: this matters.' },
    ]);
  });

  it('has nothing for text that is not a transcript', () => {
    expect(spokenLines('Meeting notes: Sync\nSummary: fine\n- [00:01:10] Ship it.')).toEqual([]);
    expect(spokenLines('')).toEqual([]);
  });

  it('keeps markup from the transcript as text', () => {
    expect(spokenLines('[00:00:05] <b>Eve</b>: <img src=x>')).toEqual([
      { time: '00:00:05', speaker: '<b>Eve</b>', text: '<img src=x>' },
    ]);
  });
});

describe('transcriptRows', () => {
  it('lists the lines of every passage in order and marks those of the cited one', () => {
    const rows = transcriptRows(
      [
        passage(1, '[00:00:05] Alice: One.', '[00:00:15] Bob: Two.'),
        passage(2, '[00:00:30] Carol: Three.'),
        passage(3, '[00:00:40] Alice: Four.'),
      ],
      2,
    );

    expect(rows.map((r) => [r.time, r.cited])).toEqual([
      ['00:00:05', false],
      ['00:00:15', false],
      ['00:00:30', true],
      ['00:00:40', false],
    ]);
  });

  it('shows a line that two passages share once, and counts it as cited when either passage is', () => {
    const passages = [
      passage(1, '[00:00:05] Alice: One.', '[00:00:15] Bob: Two.'),
      passage(2, '[00:00:15] Bob: Two.', '[00:00:30] Carol: Three.'),
      passage(3, '[00:00:30] Carol: Three.', '[00:00:40] Alice: Four.'),
    ];

    const secondCited = transcriptRows(passages, 2);
    const firstCited = transcriptRows(passages, 1);

    expect(secondCited.map((r) => [r.time, r.cited])).toEqual([
      ['00:00:05', false],
      ['00:00:15', true],
      ['00:00:30', true],
      ['00:00:40', false],
    ]);
    expect(firstCited.map((r) => [r.time, r.cited])).toEqual([
      ['00:00:05', true],
      ['00:00:15', true],
      ['00:00:30', false],
      ['00:00:40', false],
    ]);
  });

  it('keeps two different lines that look alike', () => {
    const rows = transcriptRows(
      [passage(1, '[00:00:05] Alice: Yes.'), passage(2, '[00:00:06] Alice: Yes.')],
      1,
    );

    expect(rows).toHaveLength(2);
  });

  it('has no rows when the cited passage is not among those given', () => {
    const rows = transcriptRows([passage(1, '[00:00:05] Alice: One.')], 9);

    expect(rows.some((r) => r.cited)).toBe(false);
  });
});

describe('speakerTone', () => {
  it('gives the same colour to the same name, whatever its case', () => {
    expect(speakerTone('Alice')).toBe(speakerTone('alice'));
    expect(speakerTone('Alice')).toBe(speakerTone('Alice'));
  });

  it('spreads names over several colours, each with a dark-mode variant', () => {
    const tones = new Set(
      ['Alice', 'Bob', 'Carol', 'Dan', 'Erin', 'Frank', 'Grace', 'Heidi'].map(speakerTone),
    );

    expect(tones.size).toBeGreaterThan(3);
    for (const tone of tones) expect(tone).toMatch(/^text-\w+-700 dark:text-\w+-300$/);
  });

  it('copes with any name', () => {
    expect(speakerTone('')).toMatch(/^text-/);
    expect(speakerTone('Оксана 😀')).toMatch(/^text-/);
  });
});
