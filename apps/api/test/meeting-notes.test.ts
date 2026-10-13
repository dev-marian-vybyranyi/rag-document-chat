import { describe, expect, it } from 'vitest';
import {
  MAX_ACTION_ITEMS,
  MAX_DECISIONS,
  MAX_ITEM_CHARS,
  MAX_OPEN_QUESTIONS,
  MAX_SUMMARY_CHARS,
  MAX_TOPICS,
  normalizeForMatch,
  verifyNotes,
  type ModelNotes,
} from '../src/meetings/notes.js';
import type { Turn } from '../src/meetings/transcript.js';

const turns: Turn[] = [
  { speaker: 'Alice', startMs: 5000, text: 'Morning. Let us talk about the launch date.' },
  {
    speaker: 'Bob',
    startMs: 20_000,
    text: 'I think we should move the launch to November because the vendor is late.',
  },
  {
    speaker: 'Alice',
    startMs: 45_000,
    text: 'Agreed, the launch moves to November. Carol, can you update the roadmap by Friday?',
  },
  { speaker: 'Carol', startMs: 70_000, text: 'Sure, I will update the roadmap.' },
  {
    speaker: 'Dan',
    startMs: 90_000,
    text: 'Is the relationship it builds with the vendor worth it?',
  },
];

const empty: ModelNotes = {
  summary: '',
  topics: [],
  decisions: [],
  actionItems: [],
  openQuestions: [],
};
const notesWith = (overrides: Partial<ModelNotes>): ModelNotes => ({ ...empty, ...overrides });

describe('normalizeForMatch', () => {
  it('ignores case, punctuation, spacing and look-alike forms', () => {
    expect(normalizeForMatch('  Agreed,   the LAUNCH moves — to November! ')).toBe(
      'agreed the launch moves to november',
    );
    expect(normalizeForMatch('ＮＯＶＥＭＢＥＲ')).toBe('november');
    expect(normalizeForMatch('Au​gust')).toBe('august');
  });

  it('keeps letters from other scripts and digits', () => {
    expect(normalizeForMatch('Оксана: 3 завдання')).toBe('оксана 3 завдання');
  });
});

describe('verifyNotes: evidence', () => {
  it('keeps a decision whose quote is in the transcript and takes its time from there', () => {
    const { notes, dropped } = verifyNotes(
      notesWith({
        decisions: [
          { text: 'Move the launch to November.', quote: 'the launch moves to November' },
        ],
      }),
      turns,
    );

    expect(notes.decisions).toEqual([
      {
        text: 'Move the launch to November.',
        startMs: 45_000,
        evidence: 'the launch moves to November',
      },
    ]);
    expect(dropped).toEqual({ decisions: 0, actionItems: 0, owners: 0 });
  });

  it('finds a quote whatever its case, punctuation or spacing', () => {
    const { notes } = verifyNotes(
      notesWith({
        decisions: [{ text: 'Roadmap update.', quote: '  SURE -- i will   update the roadmap ' }],
      }),
      turns,
    );

    expect(notes.decisions[0]?.startMs).toBe(70_000);
  });

  it('uses the first turn that contains the quote', () => {
    const { notes } = verifyNotes(
      notesWith({ decisions: [{ text: 'Launch.', quote: 'the launch' }] }),
      turns,
    );

    expect(notes.decisions[0]?.startMs).toBe(5000);
  });

  it.each([
    ['a paraphrase', 'we agreed to delay the launch until November'],
    ['words from two different turns', 'because the vendor is late. Agreed'],
    ['text that is not there at all', 'the budget was approved'],
    ['a quote that is too short to prove anything', 'the'],
    ['an empty quote', ''],
    ['only punctuation', '... --- ...'],
  ])('drops a decision whose quote is %s', (_label, quote) => {
    const { notes, dropped } = verifyNotes(
      notesWith({ decisions: [{ text: 'Something was decided.', quote }] }),
      turns,
    );

    expect(notes.decisions).toEqual([]);
    expect(dropped.decisions).toBe(1);
  });

  it('matches whole words only, so a quote cannot hide inside a longer word', () => {
    const { notes } = verifyNotes(
      notesWith({ decisions: [{ text: 'Ship it.', quote: 'ship it builds' }] }),
      turns,
    );

    expect(notes.decisions).toEqual([]);
  });

  it('does not accept a quote that only appears in a speaker name', () => {
    const { notes } = verifyNotes(
      notesWith({ decisions: [{ text: 'Bob decided.', quote: 'Bob I think we should move' }] }),
      turns,
    );

    expect(notes.decisions).toEqual([]);
  });

  it('drops a decision with no text even if its quote is real', () => {
    const { notes, dropped } = verifyNotes(
      notesWith({ decisions: [{ text: '  ', quote: 'the launch moves to November' }] }),
      turns,
    );

    expect(notes.decisions).toEqual([]);
    expect(dropped.decisions).toBe(1);
  });

  it('applies the same test to action items', () => {
    const { notes, dropped } = verifyNotes(
      notesWith({
        actionItems: [
          {
            task: 'Update the roadmap.',
            owner: 'Carol',
            due: 'Friday',
            quote: 'can you update the roadmap by Friday',
          },
          { task: 'Wire the money.', owner: 'Mallory', due: null, quote: 'send money to Mallory' },
        ],
      }),
      turns,
    );

    expect(notes.actionItems).toEqual([
      {
        task: 'Update the roadmap.',
        owner: 'Carol',
        due: 'Friday',
        startMs: 45_000,
        evidence: 'can you update the roadmap by Friday',
      },
    ]);
    expect(dropped.actionItems).toBe(1);
  });
});

describe('verifyNotes: owners and deadlines', () => {
  const item = (owner: string | null, due: string | null = null) =>
    notesWith({
      actionItems: [
        { task: 'Update the roadmap.', owner, due, quote: 'I will update the roadmap' },
      ],
    });

  it('keeps an owner who speaks in the meeting, in any case', () => {
    expect(verifyNotes(item('carol'), turns).notes.actionItems[0]?.owner).toBe('carol');
  });

  it('keeps an owner who is only mentioned', () => {
    const quiet: Turn[] = [
      { speaker: 'Alice', startMs: 0, text: 'Zoe, please send the invoice to the client today.' },
      { speaker: 'Bob', startMs: 9000, text: 'Fine, please send the invoice to the client today.' },
    ];
    const raw = notesWith({
      actionItems: [
        {
          task: 'Send the invoice.',
          owner: 'Zoe',
          due: 'today',
          quote: 'please send the invoice to the client today',
        },
      ],
    });

    expect(verifyNotes(raw, quiet).notes.actionItems[0]?.owner).toBe('Zoe');
  });

  it('replaces an owner the transcript never names with null, and counts it', () => {
    const { notes, dropped } = verifyNotes(item('Zed'), turns);

    expect(notes.actionItems[0]?.owner).toBeNull();
    expect(dropped.owners).toBe(1);
  });

  it('does not mistake part of a longer name for the owner', () => {
    expect(verifyNotes(item('Car'), turns).notes.actionItems[0]?.owner).toBeNull();
  });

  it('keeps no owner when the model gave none, or only blanks', () => {
    expect(verifyNotes(item(null), turns).notes.actionItems[0]?.owner).toBeNull();
    expect(verifyNotes(item('  '), turns).dropped.owners).toBe(0);
    expect(verifyNotes(item('  '), turns).notes.actionItems[0]?.owner).toBeNull();
  });

  it('keeps the deadline as said, and null for a blank one', () => {
    expect(verifyNotes(item('Carol', ' by   Friday '), turns).notes.actionItems[0]?.due).toBe(
      'by Friday',
    );
    expect(verifyNotes(item('Carol', '   '), turns).notes.actionItems[0]?.due).toBeNull();
  });
});

describe('verifyNotes: tidying what the model wrote', () => {
  it('collapses whitespace, removes invisible characters and cuts long text', () => {
    const long = 'word '.repeat(200);
    const { notes } = verifyNotes(
      notesWith({
        summary: 'A  summary\nin\tparts​.',
        topics: ['  Launch\n date  '],
        decisions: [{ text: long, quote: 'the launch moves to November' }],
        openQuestions: ['Is  it   late?‮'],
      }),
      turns,
    );

    expect(notes.summary).toBe('A summary in parts.');
    expect(notes.topics).toEqual(['Launch date']);
    expect(notes.openQuestions).toEqual(['Is it late?']);
    expect(notes.decisions[0]!.text.length).toBe(MAX_ITEM_CHARS);
    expect(notes.decisions[0]!.text.endsWith('…')).toBe(true);
  });

  it('cuts a long summary', () => {
    const { notes } = verifyNotes(notesWith({ summary: 'x'.repeat(5000) }), turns);

    expect(notes.summary.length).toBe(MAX_SUMMARY_CHARS);
  });

  it('removes repeats and blanks from topics and open questions', () => {
    const { notes } = verifyNotes(
      notesWith({
        topics: ['Launch', 'launch', ' ', 'Roadmap', 'LAUNCH'],
        openQuestions: ['Who pays?', 'who pays?', ''],
      }),
      turns,
    );

    expect(notes.topics).toEqual(['Launch', 'Roadmap']);
    expect(notes.openQuestions).toEqual(['Who pays?']);
  });

  it('reports a decision or an action item once, however the model repeated it', () => {
    const { notes } = verifyNotes(
      notesWith({
        decisions: [
          { text: 'Move the launch to November.', quote: 'the launch moves to November' },
          { text: 'move the launch to november', quote: 'move the launch to November' },
        ],
        actionItems: [
          {
            task: 'Update the roadmap.',
            owner: 'Carol',
            due: null,
            quote: 'I will update the roadmap',
          },
          {
            task: 'Update the roadmap',
            owner: null,
            due: 'Friday',
            quote: 'update the roadmap by Friday',
          },
        ],
      }),
      turns,
    );

    expect(notes.decisions).toHaveLength(1);
    expect(notes.actionItems).toHaveLength(1);
    expect(notes.actionItems[0]?.owner).toBe('Carol');
  });

  it('caps every list', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `Item number ${i} about the launch`);
    const { notes } = verifyNotes(
      notesWith({
        topics: many(40),
        openQuestions: many(40),
        decisions: Array.from({ length: 80 }, (_, i) => ({
          text: `Decision ${i}`,
          quote: 'the launch moves to November',
        })),
        actionItems: Array.from({ length: 80 }, (_, i) => ({
          task: `Task ${i}`,
          owner: null,
          due: null,
          quote: 'I will update the roadmap',
        })),
      }),
      turns,
    );

    expect(notes.topics).toHaveLength(MAX_TOPICS);
    expect(notes.openQuestions).toHaveLength(MAX_OPEN_QUESTIONS);
    expect(notes.decisions).toHaveLength(MAX_DECISIONS);
    expect(notes.actionItems).toHaveLength(MAX_ACTION_ITEMS);
  });

  it('turns an empty answer into empty notes', () => {
    expect(verifyNotes(empty, turns).notes).toEqual(empty);
    expect(verifyNotes(empty, []).notes).toEqual(empty);
  });
});
