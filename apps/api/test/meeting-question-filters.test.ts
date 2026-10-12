import { describe, expect, it } from 'vitest';
import {
  appliedFilters,
  AROUND_RADIUS_MS,
  describeTime,
  detectFilters,
  MAX_TIME_MS,
  toMeetingFilter,
  windowFor,
  type MeetingFacts,
  type QuestionFilters,
  type TimeExpression,
} from '../src/meetings/question-filters.js';

const facts = (
  id: string,
  participants: string[],
  firstStartMs: number | null = 5000,
  endMs: number | null = 3_605_000,
): MeetingFacts => ({ id, participants, firstStartMs, endMs });

const standup = facts('m1', ['Alice', 'Bob', 'Carol Jones']);

const speakersIn = (question: string, meetings: MeetingFacts[] = [standup]) =>
  detectFilters(question, meetings)?.speakers ?? [];
const timeIn = (question: string) => detectFilters(question, [standup])?.time ?? null;

describe('detectFilters: speakers', () => {
  it('finds nothing without meetings, or without a name or a time in the question', () => {
    expect(detectFilters('What did Alice say?', [])).toBeNull();
    expect(detectFilters('What was decided about pricing?', [standup])).toBeNull();
  });

  it.each([
    ['What did Alice say about pricing?', ['Alice']],
    ['what did alice say about pricing', ['Alice']],
    ['WHAT DID ALICE SAY', ['Alice']],
    ["What was Bob's concern?", ['Bob']],
    ['What was Bob’s concern?', ['Bob']],
    ['Did Bob, Alice or anyone object?', ['Alice', 'Bob']],
    ['Alice?', ['Alice']],
    ['(Alice) said no', ['Alice']],
  ])('finds the speaker in %j', (question, expected) => {
    expect([...speakersIn(question)].sort()).toEqual(expected);
  });

  it('finds a person by full name or by first name', () => {
    expect(speakersIn('What did Carol Jones promise?')).toEqual(['Carol Jones']);
    expect(speakersIn('What did Carol promise?')).toEqual(['Carol Jones']);
  });

  it('does not take a first name that two people share for either of them', () => {
    const team = facts('m1', ['Carol Jones', 'Carol Smith', 'Dan']);

    expect(speakersIn('What did Carol say?', [team])).toEqual([]);
    expect(speakersIn('What did Carol Smith say?', [team])).toEqual(['Carol Smith']);
  });

  it('does not take part of another word for a name', () => {
    expect(speakersIn('Tell me about Alicia and the Carolina office')).toEqual([]);
    expect(speakersIn('What about Bobsled training?')).toEqual([]);
    expect(speakersIn('The malice of the plan')).toEqual([]);
  });

  it('finds names in other alphabets', () => {
    const meeting = facts('m1', ['Оксана', 'Ørjan']);

    expect(speakersIn('Що сказала оксана?', [meeting])).toEqual(['Оксана']);
    expect(speakersIn('What did ørjan say', [meeting])).toEqual(['Ørjan']);
  });

  it('returns every spelling of a name used in different meetings', () => {
    const meetings = [facts('m1', ['Bob']), facts('m2', ['bob', 'Alice'])];

    expect([...speakersIn('What did Bob say?', meetings)].sort()).toEqual(['Bob', 'bob']);
  });

  it('knows people from all the meetings it is given', () => {
    const meetings = [facts('m1', ['Alice']), facts('m2', ['Zoe'])];

    expect([...speakersIn('Did Alice agree with Zoe?', meetings)].sort()).toEqual(['Alice', 'Zoe']);
  });

  describe('names that are also ordinary words', () => {
    const team = facts('m1', ['Will', 'Grace', 'Mark']);

    it.each(['What did Will say about pricing?', 'Did Grace agree?', 'Why did the team ask Mark?'])(
      'is found with a capital letter in %j',
      (question) => {
        expect(speakersIn(question, [team]).length).toBe(1);
      },
    );

    it.each([
      'what will we do about pricing',
      'Will we ship on Friday?',
      'Please mark the decision as final',
      'Is there hope for the grace period?',
    ])('is not found in %j', (question) => {
      expect(speakersIn(question, [team])).toEqual([]);
    });
  });
});

describe('detectFilters: time', () => {
  const expectations: Array<[string, TimeExpression]> = [
    ['What happened at 25:00?', { kind: 'around', ms: 1_500_000 }],
    ['What was said around 1:02:03?', { kind: 'around', ms: 3_723_000 }],
    ['What is discussed at minute 12:30', { kind: 'around', ms: 750_000 }],
    ['Summarise 25:00 please', { kind: 'around', ms: 1_500_000 }],
    ['What happened between 10:00 and 20:00?', { kind: 'range', fromMs: 600_000, toMs: 1_200_000 }],
    ['Anything from 10:00 to 20:00', { kind: 'range', fromMs: 600_000, toMs: 1_200_000 }],
    ['What was said 10:00-20:00', { kind: 'range', fromMs: 600_000, toMs: 1_200_000 }],
    ['What was said 10:00 – 20:00', { kind: 'range', fromMs: 600_000, toMs: 1_200_000 }],
    ['between 20:00 and 10:00', { kind: 'range', fromMs: 600_000, toMs: 1_200_000 }],
    ['What came up after 25:00?', { kind: 'after', ms: 1_500_000 }],
    ['What changed since 25:00', { kind: 'after', ms: 1_500_000 }],
    ['anything following 25:00', { kind: 'after', ms: 1_500_000 }],
    ['What was said before 25:00?', { kind: 'before', ms: 1_500_000 }],
    ['until 05:00', { kind: 'before', ms: 300_000 }],
    ['What did they decide by 25:00', { kind: 'before', ms: 1_500_000 }],
    ['What happened in the first 10 minutes?', { kind: 'first', ms: 600_000 }],
    ['first 10 mins', { kind: 'first', ms: 600_000 }],
    ['What was said in the first minute', { kind: 'first', ms: 60_000 }],
    ['first 30 seconds', { kind: 'first', ms: 30_000 }],
    ['the first five minutes', { kind: 'first', ms: 300_000 }],
    ['What happened in the last 5 minutes?', { kind: 'last', ms: 300_000 }],
    ['in the last two minutes', { kind: 'last', ms: 120_000 }],
    ['the last hour', { kind: 'last', ms: 3_600_000 }],
    ['the last 2 hours', { kind: 'last', ms: 7_200_000 }],
  ];

  it.each(expectations)('reads %j', (question, expected) => {
    expect(timeIn(question)).toEqual(expected);
  });

  it.each([
    'What was decided about pricing?',
    'What happened at 99:99?',
    'The first quarter results',
    'Who spoke last?',
    'Our first priority was 1.5:3',
    'last week',
  ])('finds no time in %j', (question) => {
    expect(timeIn(question)).toBeNull();
  });

  it('prefers a time written as a clock to one written in words', () => {
    expect(timeIn('In the first 10 minutes, what happened at 25:00?')).toEqual({
      kind: 'around',
      ms: 1_500_000,
    });
  });

  it('reads a speaker and a time from the same question', () => {
    expect(detectFilters('What did Bob say in the last 5 minutes?', [standup])).toEqual({
      speakers: ['Bob'],
      time: { kind: 'last', ms: 300_000 },
    });
  });
});

describe('windows', () => {
  it.each<[string, TimeExpression, { fromMs: number; toMs: number } | null]>([
    [
      'a range as given',
      { kind: 'range', fromMs: 600_000, toMs: 1_200_000 },
      { fromMs: 600_000, toMs: 1_200_000 },
    ],
    [
      'a moment with a margin either side',
      { kind: 'around', ms: 600_000 },
      { fromMs: 600_000 - AROUND_RADIUS_MS, toMs: 600_000 + AROUND_RADIUS_MS },
    ],
    [
      'a moment near the start without going below zero',
      { kind: 'around', ms: 20_000 },
      { fromMs: 0, toMs: 20_000 + AROUND_RADIUS_MS },
    ],
    ['everything after', { kind: 'after', ms: 600_000 }, { fromMs: 600_000, toMs: MAX_TIME_MS }],
    ['everything before', { kind: 'before', ms: 600_000 }, { fromMs: 0, toMs: 600_000 }],
    [
      'the beginning of the meeting',
      { kind: 'first', ms: 600_000 },
      { fromMs: 5000, toMs: 605_000 },
    ],
    [
      'the end of the meeting',
      { kind: 'last', ms: 300_000 },
      { fromMs: 3_305_000, toMs: 3_605_000 },
    ],
    [
      'an end that is longer than the meeting',
      { kind: 'last', ms: 9_000_000 },
      { fromMs: 0, toMs: 3_605_000 },
    ],
  ])('is %s', (_label, time, expected) => {
    expect(windowFor(time, standup)).toEqual(expected);
  });

  it('cannot place the start or end of a meeting whose length is unknown', () => {
    const unknown = facts('m2', ['Zoe'], null, null);

    expect(windowFor({ kind: 'first', ms: 1000 }, unknown)).toBeNull();
    expect(windowFor({ kind: 'last', ms: 1000 }, unknown)).toBeNull();
    expect(windowFor({ kind: 'after', ms: 1000 }, unknown)).not.toBeNull();
  });

  it('is worked out for each meeting on its own clock', () => {
    const late = facts('m2', ['Zoe'], 50_000_000, 50_900_000);

    const filter = toMeetingFilter({ speakers: ['Alice'], time: { kind: 'first', ms: 600_000 } }, [
      standup,
      late,
    ]);

    expect(filter).toEqual({
      speakers: ['Alice'],
      windows: [
        { documentId: 'm1', fromMs: 5000, toMs: 605_000 },
        { documentId: 'm2', fromMs: 50_000_000, toMs: 50_600_000 },
      ],
    });
  });

  it('leaves out a meeting it cannot place, so that meeting is not cut by time', () => {
    const unknown = facts('m2', ['Zoe'], null, null);

    const filter = toMeetingFilter({ speakers: [], time: { kind: 'last', ms: 60_000 } }, [
      standup,
      unknown,
    ]);

    expect(filter.windows.map((w) => w.documentId)).toEqual(['m1']);
  });

  it('has no windows when the question names no time', () => {
    expect(toMeetingFilter({ speakers: ['Bob'], time: null }, [standup])).toEqual({
      speakers: ['Bob'],
      windows: [],
    });
  });
});

describe('describing the filters', () => {
  it.each<[TimeExpression, string]>([
    [{ kind: 'range', fromMs: 600_000, toMs: 1_200_000 }, '00:10:00–00:20:00'],
    [{ kind: 'around', ms: 1_500_000 }, 'around 00:25:00'],
    [{ kind: 'after', ms: 1_500_000 }, 'after 00:25:00'],
    [{ kind: 'before', ms: 1_500_000 }, 'before 00:25:00'],
    [{ kind: 'first', ms: 600_000 }, 'first 10 minutes'],
    [{ kind: 'first', ms: 60_000 }, 'first 1 minute'],
    [{ kind: 'first', ms: 30_000 }, 'first 30 seconds'],
    [{ kind: 'last', ms: 3_600_000 }, 'last 1 hour'],
    [{ kind: 'last', ms: 7_200_000 }, 'last 2 hours'],
  ])('shows %j as %s', (time, text) => {
    expect(describeTime(time)).toBe(text);
  });

  it('says what was applied, and whether it had to be given up', () => {
    const filters: QuestionFilters = { speakers: ['Bob'], time: { kind: 'first', ms: 600_000 } };

    expect(appliedFilters(filters, false)).toEqual({
      speakers: ['Bob'],
      time: 'first 10 minutes',
      relaxed: false,
    });
    expect(appliedFilters({ speakers: [], time: null }, true)).toEqual({
      speakers: [],
      time: null,
      relaxed: true,
    });
  });
});
