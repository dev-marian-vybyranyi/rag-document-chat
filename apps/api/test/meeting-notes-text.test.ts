import { describe, expect, it } from 'vitest';
import { chunkTranscript } from '../src/meetings/chunker.js';
import { notesPassages, NOTES_PASSAGE_MAX_CHARS } from '../src/meetings/notes-text.js';
import { turnsFromPassages } from '../src/meetings/reconstruct.js';
import type { Turn } from '../src/meetings/transcript.js';
import type { MeetingNotes } from '../src/meetings/types.js';
import { seededRandom } from './helpers/chunk-invariants.js';

const notes: MeetingNotes = {
  summary: 'The team planned the release.',
  topics: ['Release', 'Roadmap'],
  decisions: [{ text: 'Ship on Friday.', startMs: 120_000, evidence: 'we ship on Friday' }],
  actionItems: [
    { task: 'Update the changelog.', owner: 'Carol', due: 'today', startMs: 70_000, evidence: 'x' },
    { task: 'Book the room.', owner: null, due: null, startMs: 3_725_000, evidence: 'y' },
  ],
  openQuestions: ['Who pays for the launch?'],
};

const context = {
  title: 'Release sync',
  heldOn: '2026-10-01',
  participants: ['Alice', 'Bob', 'Carol'],
};

describe('notesPassages', () => {
  it('writes the notes as readable text under the meeting name', () => {
    expect(notesPassages(notes, context)).toEqual([
      [
        'Meeting notes: Release sync (2026-10-01)',
        'Participants: Alice, Bob, Carol',
        'Summary: The team planned the release.',
        'Topics: Release; Roadmap',
        'Decisions:',
        '- [00:02:00] Ship on Friday.',
        'Action items:',
        '- [00:01:10] Update the changelog. (owner: Carol, due: today)',
        '- [01:02:05] Book the room. (no owner stated)',
        'Open questions:',
        '- Who pays for the launch?',
      ].join('\n'),
    ]);
  });

  it('leaves out the date when it is unknown, and the sections that are empty', () => {
    const [passage] = notesPassages(
      { ...notes, topics: [], decisions: [], openQuestions: [] },
      { title: 'Sync', participants: [] },
    );

    expect(passage).toBe(
      [
        'Meeting notes: Sync',
        'Summary: The team planned the release.',
        'Action items:',
        '- [00:01:10] Update the changelog. (owner: Carol, due: today)',
        '- [01:02:05] Book the room. (no owner stated)',
      ].join('\n'),
    );
  });

  it('has no passage when there is nothing to say', () => {
    const empty: MeetingNotes = {
      summary: '',
      topics: [],
      decisions: [],
      actionItems: [],
      openQuestions: [],
    };

    expect(notesPassages(empty, context)).toEqual([]);
    expect(notesPassages({ ...empty, topics: ['Only a topic'] }, context)).toEqual([]);
  });

  it('splits long notes into passages that each name the meeting and the section they continue', () => {
    const many: MeetingNotes = {
      ...notes,
      decisions: [],
      actionItems: Array.from({ length: 40 }, (_, i) => ({
        task: `Task number ${i} with some detail.`,
        owner: 'Carol',
        due: null,
        startMs: i * 1000,
        evidence: 'x',
      })),
    };

    const passages = notesPassages(many, context, 600);

    expect(passages.length).toBeGreaterThan(2);
    for (const passage of passages) {
      expect(passage.length).toBeLessThanOrEqual(600);
      expect(passage.startsWith('Meeting notes: Release sync (2026-10-01)\n')).toBe(true);
    }
    for (const passage of passages.slice(1)) {
      expect(passage.split('\n')[1]).toBe('Action items:');
    }
    const items = passages.flatMap((p) => p.split('\n')).filter((line) => line.startsWith('- ['));
    expect(items).toHaveLength(40);
    expect(new Set(items).size).toBe(40);
  });

  it('has a default size that fits the context of an answer', () => {
    expect(NOTES_PASSAGE_MAX_CHARS).toBe(3000);
  });
});

describe('turnsFromPassages', () => {
  const turn = (speaker: string, startMs: number, text: string): Turn => ({
    speaker,
    startMs,
    text,
  });

  it('reads the turns back from the passages of a meeting', () => {
    const turns = [turn('Alice', 5000, 'Hello.'), turn('Bob', 15_000, 'Hi there.')];

    expect(
      turnsFromPassages(chunkTranscript(turns, { title: 'Sync' }).map((c) => c.content)),
    ).toEqual(turns);
  });

  it('does not repeat the turn that two passages share', () => {
    const turns = Array.from({ length: 30 }, (_, i) =>
      turn(i % 2 ? 'Bob' : 'Alice', i * 10_000, `Point number ${i} about the plan.`),
    );
    const chunks = chunkTranscript(turns, { maxTokens: 60 });

    expect(chunks.length).toBeGreaterThan(3);
    expect(turnsFromPassages(chunks.map((c) => c.content))).toEqual(turns);
  });

  it('joins the pieces of one long turn', () => {
    const speech = Array.from(
      { length: 20 },
      (_, i) => `We should move item ${i} to November because the vendor is late.`,
    ).join(' ');
    const turns = [turn('Alice', 65_000, speech), turn('Bob', 95_000, 'Agreed.')];

    expect(
      turnsFromPassages(chunkTranscript(turns, { maxTokens: 60 }).map((c) => c.content)),
    ).toEqual(turns);
  });

  it('keeps a colon in speech and ignores everything that is not a line of speech', () => {
    const passages = [
      'Meeting: Sync\n[00:00:05] Alice: Note: this: matters\nstray line\n[00:00:09] Bob: ok',
    ];

    expect(turnsFromPassages(passages)).toEqual([
      turn('Alice', 5000, 'Note: this: matters'),
      turn('Bob', 9000, 'ok'),
    ]);
  });

  it('is not confused by the notes passages that sit among the passages', () => {
    const passages = ['Meeting: Sync\n[00:00:05] Alice: Hello.', notesPassages(notes, context)[0]!];

    expect(turnsFromPassages(passages)).toEqual([turn('Alice', 5000, 'Hello.')]);
  });

  it('gives nothing for no passages', () => {
    expect(turnsFromPassages([])).toEqual([]);
  });

  it('gets back every turn of random meetings, to the second', () => {
    const random = seededRandom(3);
    const words = ['we', 'ship', 'the', 'release', 'on', 'friday', 'budget', 'plan', 'ok'];
    for (let run = 0; run < 100; run++) {
      let startMs = 0;
      const turns = Array.from({ length: 1 + Math.floor(random() * 40) }, () => {
        startMs += (1 + Math.floor(random() * 90)) * 1000;
        const count = random() < 0.1 ? 120 : 1 + Math.floor(random() * 25);
        const text = Array.from(
          { length: count },
          (_, i) => `${words[Math.floor(random() * words.length)]}${i % 11 === 10 ? '.' : ''}`,
        ).join(' ');
        return turn(['Alice', 'Bob', 'Carol Jones'][Math.floor(random() * 3)]!, startMs, text);
      });

      const chunks = chunkTranscript(turns, {
        title: 'Sync',
        heldOn: '2026-10-01',
        maxTokens: 60 + Math.floor(random() * 200),
      });

      expect(turnsFromPassages(chunks.map((c) => c.content))).toEqual(turns);
    }
  });
});
