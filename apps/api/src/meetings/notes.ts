import { z } from 'zod';
import { stripInvisibleCharacters } from '../rag/sanitize.js';
import type { MeetingActionItem, MeetingDecision, MeetingNotes } from './types.js';
import type { Turn } from './transcript.js';

export const MAX_DECISIONS = 30;
export const MAX_ACTION_ITEMS = 50;
export const MAX_TOPICS = 12;
export const MAX_OPEN_QUESTIONS = 15;
export const MAX_SUMMARY_CHARS = 1200;
export const MAX_ITEM_CHARS = 300;
export const MAX_SHORT_CHARS = 80;
export const MIN_EVIDENCE_CHARS = 8;

export const modelNotesSchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
  decisions: z.array(z.object({ text: z.string(), quote: z.string() })),
  actionItems: z.array(
    z.object({
      task: z.string(),
      owner: z.string().nullable(),
      due: z.string().nullable(),
      quote: z.string(),
    }),
  ),
  openQuestions: z.array(z.string()),
});

export type ModelNotes = z.infer<typeof modelNotesSchema>;

export interface DroppedNotes {
  decisions: number;
  actionItems: number;
  owners: number;
}

export interface VerifiedNotes {
  notes: MeetingNotes;
  dropped: DroppedNotes;
}

const clean = (text: string, limit: number) => {
  const collapsed = stripInvisibleCharacters(text).replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
};

export const normalizeForMatch = (text: string) =>
  stripInvisibleCharacters(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (id === '' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function verifyNotes(raw: ModelNotes, turns: Turn[]): VerifiedNotes {
  const spoken = turns.map((turn) => ({
    startMs: turn.startMs,
    text: ` ${normalizeForMatch(turn.text)} `,
  }));
  const everything = ` ${normalizeForMatch(turns.map((turn) => `${turn.speaker} ${turn.text}`).join(' '))} `;

  const locate = (quote: string): { startMs: number; evidence: string } | null => {
    const evidence = clean(quote, MAX_ITEM_CHARS);
    const needle = normalizeForMatch(evidence);
    if (needle.length < MIN_EVIDENCE_CHARS) return null;
    const found = spoken.find((turn) => turn.text.includes(` ${needle} `));
    return found ? { startMs: found.startMs, evidence } : null;
  };

  const dropped: DroppedNotes = { decisions: 0, actionItems: 0, owners: 0 };

  const decisions: MeetingDecision[] = [];
  for (const item of raw.decisions) {
    const text = clean(item.text, MAX_ITEM_CHARS);
    const where = locate(item.quote);
    if (text === '' || !where) dropped.decisions++;
    else decisions.push({ text, ...where });
  }

  const actionItems: MeetingActionItem[] = [];
  for (const item of raw.actionItems) {
    const task = clean(item.task, MAX_ITEM_CHARS);
    const where = locate(item.quote);
    if (task === '' || !where) {
      dropped.actionItems++;
      continue;
    }
    const named = item.owner === null ? '' : clean(item.owner, MAX_SHORT_CHARS);
    const owner =
      named !== '' && everything.includes(` ${normalizeForMatch(named)} `) ? named : null;
    if (named !== '' && owner === null) dropped.owners++;
    const due = item.due === null ? '' : clean(item.due, MAX_SHORT_CHARS);
    actionItems.push({ task, owner, due: due === '' ? null : due, ...where });
  }

  const short = (items: string[], limit: number, max: number) =>
    uniqueBy(
      items.map((item) => clean(item, limit)),
      (item) => item.toLowerCase(),
    ).slice(0, max);

  return {
    notes: {
      summary: clean(raw.summary, MAX_SUMMARY_CHARS),
      topics: short(raw.topics, MAX_SHORT_CHARS, MAX_TOPICS),
      decisions: uniqueBy(decisions, (d) => normalizeForMatch(d.text)).slice(0, MAX_DECISIONS),
      actionItems: uniqueBy(actionItems, (a) => normalizeForMatch(a.task)).slice(
        0,
        MAX_ACTION_ITEMS,
      ),
      openQuestions: short(raw.openQuestions, MAX_ITEM_CHARS, MAX_OPEN_QUESTIONS),
    },
    dropped,
  };
}
