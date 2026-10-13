import { formatTimestamp, parseTimestamp, TIMESTAMP_SOURCE } from './timestamp.js';

export interface MeetingFacts {
  id: string;
  participants: string[];
  firstStartMs: number | null;
  endMs: number | null;
}

export type TimeExpression =
  | { kind: 'range'; fromMs: number; toMs: number }
  | { kind: 'around'; ms: number }
  | { kind: 'after'; ms: number }
  | { kind: 'before'; ms: number }
  | { kind: 'first'; ms: number }
  | { kind: 'last'; ms: number };

export interface QuestionFilters {
  speakers: string[];
  time: TimeExpression | null;
}

export interface TimeWindow {
  documentId: string;
  fromMs: number;
  toMs: number;
}

export interface MeetingFilter {
  speakers: string[];
  windows: TimeWindow[];
}

export interface AppliedFilters {
  speakers: string[];
  time: string | null;
  relaxed: boolean;
}

export const AROUND_RADIUS_MS = 60_000;
export const MAX_TIME_MS = 2_147_483_647;

const SECOND = 1000;
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  sixty: 60,
};
const UNIT_MS: Record<string, number> = {
  second: SECOND,
  minute: 60 * SECOND,
  min: 60 * SECOND,
  hour: 3600 * SECOND,
};

const COMMON_WORD_NAMES = new Set([
  'will',
  'mark',
  'may',
  'bill',
  'rob',
  'pat',
  'grace',
  'hope',
  'joy',
  'art',
  'dean',
  'frank',
  'rose',
  'june',
  'april',
  'guy',
  'sue',
]);

const TIMESTAMP = new RegExp(String.raw`(?<![\d:])(${TIMESTAMP_SOURCE})(?![\d:])`, 'g');
const RELATIVE = new RegExp(
  String.raw`\b(first|last)\s+(?:(\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\s+)?(second|minute|min|hour)s?\b`,
  'i',
);
const RANGE_JOINER = /^\s*(?:and|to|until|till|-|–|—)\s*$/i;
const DIRECTION =
  /(after|since|following|from|before|until|till|by|at|around|near|about)\s+(?:the\s+)?(?:minute\s+)?$/i;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function timeFrom(query: string): TimeExpression | null {
  const stamps = [...query.matchAll(TIMESTAMP)].flatMap((match) => {
    const ms = parseTimestamp(match[1]!);
    return ms === null ? [] : [{ ms, start: match.index!, end: match.index! + match[0].length }];
  });

  const [first, second] = stamps;
  if (first && second && RANGE_JOINER.test(query.slice(first.end, second.start))) {
    return {
      kind: 'range',
      fromMs: Math.min(first.ms, second.ms),
      toMs: Math.max(first.ms, second.ms),
    };
  }
  if (first) {
    const before = DIRECTION.exec(
      query.slice(Math.max(0, first.start - 20), first.start),
    )?.[1]?.toLowerCase();
    if (before === 'after' || before === 'since' || before === 'following' || before === 'from') {
      return { kind: 'after', ms: first.ms };
    }
    if (before === 'before' || before === 'until' || before === 'till' || before === 'by') {
      return { kind: 'before', ms: first.ms };
    }
    return { kind: 'around', ms: first.ms };
  }

  const relative = RELATIVE.exec(query);
  if (!relative) return null;
  const count =
    relative[2] === undefined
      ? 1
      : /^\d+$/.test(relative[2])
        ? Number(relative[2])
        : NUMBER_WORDS[relative[2].toLowerCase()]!;
  const unit = UNIT_MS[relative[3]!.toLowerCase()]!;
  return { kind: relative[1]!.toLowerCase() === 'first' ? 'first' : 'last', ms: count * unit };
}

function speakersFrom(query: string, facts: MeetingFacts[]): string[] {
  const spellings = new Map<string, Set<string>>();
  const firstWords = new Map<string, Set<string>>();
  for (const name of facts.flatMap((meeting) => meeting.participants)) {
    const key = name.toLocaleLowerCase();
    spellings.set(key, (spellings.get(key) ?? new Set()).add(name));
    const [head, ...rest] = key.split(' ');
    if (head && rest.length > 0 && head.length >= 3) {
      firstWords.set(head, (firstWords.get(head) ?? new Set()).add(key));
    }
  }

  const aliases = new Map<string, Set<string>>();
  for (const key of spellings.keys()) aliases.set(key, new Set([key]));
  for (const [head, owners] of firstWords) {
    if (owners.size === 1 && !spellings.has(head)) aliases.set(head, owners);
  }

  const found = new Set<string>();
  for (const [alias, owners] of aliases) {
    const pattern = new RegExp(
      String.raw`(?<![\p{L}\p{N}])${escapeRegExp(alias)}(?![\p{L}\p{N}])`,
      'giu',
    );
    const common = COMMON_WORD_NAMES.has(alias);
    for (const match of query.matchAll(pattern)) {
      const word = match[0];
      const startsSentence = query.slice(0, match.index).trim() === '';
      const capitalised =
        word[0] === word[0]!.toLocaleUpperCase() && word[0] !== word[0]!.toLocaleLowerCase();
      if (common && (startsSentence || !capitalised)) continue;
      for (const owner of owners) for (const spelling of spellings.get(owner)!) found.add(spelling);
    }
  }
  return [...found];
}

export function detectFilters(query: string, facts: MeetingFacts[]): QuestionFilters | null {
  if (facts.length === 0) return null;
  const speakers = speakersFrom(query, facts);
  const time = timeFrom(query);
  return speakers.length === 0 && time === null ? null : { speakers, time };
}

export function windowFor(
  time: TimeExpression,
  facts: MeetingFacts,
): { fromMs: number; toMs: number } | null {
  switch (time.kind) {
    case 'range':
      return { fromMs: time.fromMs, toMs: time.toMs };
    case 'around':
      return { fromMs: Math.max(0, time.ms - AROUND_RADIUS_MS), toMs: time.ms + AROUND_RADIUS_MS };
    case 'after':
      return { fromMs: time.ms, toMs: MAX_TIME_MS };
    case 'before':
      return { fromMs: 0, toMs: time.ms };
    case 'first':
      return facts.firstStartMs === null
        ? null
        : { fromMs: facts.firstStartMs, toMs: facts.firstStartMs + time.ms };
    case 'last':
      return facts.endMs === null
        ? null
        : { fromMs: Math.max(0, facts.endMs - time.ms), toMs: facts.endMs };
  }
}

export function toMeetingFilter(filters: QuestionFilters, facts: MeetingFacts[]): MeetingFilter {
  const windows = filters.time
    ? facts.flatMap((meeting) => {
        const window = windowFor(filters.time!, meeting);
        return window ? [{ documentId: meeting.id, ...window }] : [];
      })
    : [];
  return { speakers: filters.speakers, windows };
}

export function describeTime(time: TimeExpression): string {
  const length = (ms: number) => {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? '' : 's'}`;
    if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
    return `${ms / SECOND} seconds`;
  };
  switch (time.kind) {
    case 'range':
      return `${formatTimestamp(time.fromMs)}–${formatTimestamp(time.toMs)}`;
    case 'around':
      return `around ${formatTimestamp(time.ms)}`;
    case 'after':
      return `after ${formatTimestamp(time.ms)}`;
    case 'before':
      return `before ${formatTimestamp(time.ms)}`;
    case 'first':
      return `first ${length(time.ms)}`;
    case 'last':
      return `last ${length(time.ms)}`;
  }
}

export function appliedFilters(filters: QuestionFilters, relaxed: boolean): AppliedFilters {
  return {
    speakers: filters.speakers,
    time: filters.time ? describeTime(filters.time) : null,
    relaxed,
  };
}
