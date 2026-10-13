import {
  MEETING_VARIANTS,
  type MeetingRetrievalReport,
  type MeetingVariant,
} from './meeting-eval.js';
import type { NotesScore, NotesSummary } from './notes-eval.js';
import type { RankSummary } from './metrics.js';
import { QUESTION_KINDS } from './golden-meetings.js';

const pct = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);
const optionalPct = (value: number | null) => (value === null ? 'n/a'.padStart(4) : pct(value));
const label = (text: string, width: number) => text.padEnd(width);

function table(title: string, summary: Record<MeetingVariant, RankSummary>, ks: number[]) {
  const header = [
    label(`${title} (${summary.hybrid.questions})`, 24),
    ...ks.map((k) => `hit@${k}`.padStart(7)),
    'MRR'.padStart(7),
  ].join('');
  const lines = MEETING_VARIANTS.map((variant) =>
    [
      label(`  ${variant}`, 24),
      ...ks.map((k) => pct(summary[variant].hitAt[k] ?? 0).padStart(7)),
      summary[variant].mrr.toFixed(3).padStart(7),
    ].join(''),
  );
  return [header, ...lines].join('\n');
}

export function formatMeetingReport(report: MeetingRetrievalReport, currentThreshold: number) {
  const out: string[] = [];
  const { summary, ks } = report;

  out.push(
    `Retrieval quality over meetings (top ${report.cutoff} passages; "unfiltered" is hybrid without the speaker and time filters)`,
    '',
    table('all answerable', summary.all, ks),
  );
  for (const kind of QUESTION_KINDS) {
    if (summary.byKind[kind].hybrid.questions === 0) continue;
    out.push('', table(kind, summary.byKind[kind], ks));
  }

  const { filters } = report;
  out.push(
    '',
    `What the questions name: the app picked out the right speaker and time for ${filters.recognised} of ${filters.named} questions that name one; ` +
      `${filters.unexpected} other questions got a filter they did not ask for; ${filters.relaxed} had to give the filter up.`,
  );
  for (const row of report.rows.filter((r) => r.filters.expected && !r.filters.agrees)) {
    out.push(
      `  ${row.id}: expected ${JSON.stringify(row.filters.expected)}, got ${JSON.stringify(row.filters.actual)}`,
    );
  }

  const misses = report.rows.filter((row) => row.ranks.hybrid === null);
  out.push(
    '',
    `Hybrid misses (${misses.length}): the right moment is not in the top ${report.cutoff}`,
  );
  for (const miss of misses) {
    const where = miss.hybridTop.map(
      (hit) =>
        `${hit.file}${hit.startMs === null ? ' (notes)' : `@${Math.round(hit.startMs / 1000)}s`}`,
    );
    out.push(
      `  ${miss.id} [${miss.kind}]: "${miss.question}"`,
      `    got: ${where.join(', ') || 'nothing'}`,
    );
  }

  out.push('', 'Relevance threshold (best vector score of the passages the model would get)');
  out.push(
    '  threshold  answers the answerable  refuses the unanswerable',
    ...report.thresholds.map((point) => {
      const mark = point.threshold === currentThreshold ? '  <- current' : '';
      return `  ${point.threshold.toFixed(3)}      ${pct(point.answered)}                     ${pct(point.refused)}${mark}`;
    }),
  );
  const scored = (rows: Array<{ bestScore: number | null }>) =>
    rows.flatMap((row) => (row.bestScore === null ? [] : [row.bestScore]));
  const range = (values: number[]) =>
    values.length === 0
      ? 'none'
      : `${Math.min(...values).toFixed(3)} to ${Math.max(...values).toFixed(3)}`;
  out.push(
    '',
    `  best scores, answerable:   ${range(scored(report.rows))}`,
    `  best scores, unanswerable: ${range(scored(report.unanswerable))}`,
    '  closest unanswerable questions:',
    ...[...report.unanswerable]
      .sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1))
      .slice(0, 4)
      .map(
        (row) => `    ${(row.bestScore ?? 0).toFixed(3)}  ${row.id}${row.hard ? ' (hard)' : ''}`,
      ),
    '  weakest answerable questions:',
    ...[...report.rows]
      .filter((row) => row.bestScore !== null)
      .sort((a, b) => a.bestScore! - b.bestScore!)
      .slice(0, 4)
      .map((row) => `    ${row.bestScore!.toFixed(3)}  ${row.id}`),
  );
  return out.join('\n');
}

export function formatNotesReport(scores: NotesScore[], summary: NotesSummary): string {
  const out: string[] = [
    `Meeting notes (${summary.withNotes} of ${summary.meetings} meetings have notes)`,
    '',
    `  decisions found           ${pct(summary.decisionRecall)}`,
    `  decisions supported       ${optionalPct(summary.decisionPrecision)}   (reported decisions that match one from the answer key)`,
    `  superseded decisions      ${summary.staleReported} reported as final (should be 0)`,
    `  proposals as decisions    ${summary.proposalsReported} (should be 0)`,
    `  action items found        ${pct(summary.actionRecall)}`,
    `  owner right               ${optionalPct(summary.ownerAccuracy)}   (of the action items found; no owner stated must stay empty)`,
    `  deadline right            ${optionalPct(summary.dueAccuracy)}`,
    `  open questions found      ${pct(summary.questionRecall)}`,
  ];
  for (const score of scores) {
    if (!score.hasNotes) {
      out.push('', `  ${score.meeting}: no notes were written`);
    } else if (score.missed.length > 0) {
      out.push('', `  ${score.meeting}:`, ...score.missed.map((item) => `    missed ${item}`));
    }
  }
  return out.join('\n');
}
