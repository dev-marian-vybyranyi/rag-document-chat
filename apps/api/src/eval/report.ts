import { VARIANTS, type RetrievalReport, type Variant } from './retrieval-eval.js';
import type { RankSummary } from './metrics.js';

const pct = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);
const label = (text: string, width: number) => text.padEnd(width);

function summaryTable(title: string, summary: Record<Variant, RankSummary>, ks: number[]) {
  const questions = summary.hybrid.questions;
  const header = [
    label(`${title} (${questions})`, 22),
    ...ks.map((k) => `hit@${k}`.padStart(7)),
    'MRR'.padStart(7),
  ].join('');
  const lines = VARIANTS.map((variant) =>
    [
      label(`  ${variant}`, 22),
      ...ks.map((k) => pct(summary[variant].hitAt[k] ?? 0).padStart(7)),
      summary[variant].mrr.toFixed(3).padStart(7),
    ].join(''),
  );
  return [header, ...lines].join('\n');
}

export function formatRetrievalReport(report: RetrievalReport, currentThreshold: number): string {
  const out: string[] = [];
  const { summary, ks } = report;

  out.push(
    `Retrieval quality (top ${report.cutoff} passages, ${report.rewrite ? 'with' : 'without'} query rewriting)`,
    '',
    summaryTable('all answerable', summary.all, ks),
    '',
    summaryTable('standalone', summary.standalone, ks),
    '',
    summaryTable('follow-ups', summary.followUps, ks),
  );

  const misses = report.rows.filter((row) => row.ranks.hybrid === null);
  out.push(
    '',
    `Hybrid misses (${misses.length}): the right passage is not in the top ${report.cutoff}`,
  );
  for (const miss of misses) {
    const where = miss.hybridTop.map((hit) => `${hit.filename}${hit.page ? `#${hit.page}` : ''}`);
    out.push(`  ${miss.id}: "${miss.query}"`, `    got: ${where.join(', ') || 'nothing'}`);
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
  const answerable = scored(report.rows);
  const unanswerable = scored(report.unanswerable);
  const range = (values: number[]) =>
    values.length === 0
      ? 'none'
      : `${Math.min(...values).toFixed(3)} to ${Math.max(...values).toFixed(3)}`;
  out.push(
    '',
    `  best scores, answerable:   ${range(answerable)}`,
    `  best scores, unanswerable: ${range(unanswerable)}`,
  );

  const hardest = [...report.unanswerable]
    .sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1))
    .slice(0, 4);
  out.push('  closest unanswerable questions:');
  for (const row of hardest) {
    out.push(`    ${(row.bestScore ?? 0).toFixed(3)}  ${row.id}${row.hard ? ' (hard)' : ''}`);
  }
  const weakest = [...report.rows]
    .filter((row) => row.bestScore !== null)
    .sort((a, b) => a.bestScore! - b.bestScore!)
    .slice(0, 4);
  out.push('  weakest answerable questions:');
  for (const row of weakest) out.push(`    ${row.bestScore!.toFixed(3)}  ${row.id}`);

  return out.join('\n');
}
