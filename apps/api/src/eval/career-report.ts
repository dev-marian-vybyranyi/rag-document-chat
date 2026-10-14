import {
  CAREER_VARIANTS,
  RELEVANCE_LEVELS,
  type CareerRetrievalReport,
  type CareerVariant,
  type FitReport,
  type JobScore,
} from './career-eval.js';
import type { RankSummary } from './metrics.js';

const pct = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);
const optionalPct = (value: number | null) => (value === null ? 'n/a'.padStart(4) : pct(value));
const label = (text: string, width: number) => text.padEnd(width);

function table(title: string, summary: Record<CareerVariant, RankSummary>, ks: number[]) {
  const header = [
    label(`${title} (${summary.hybrid.questions})`, 24),
    ...ks.map((k) => `hit@${k}`.padStart(7)),
    'MRR'.padStart(7),
  ].join('');
  const lines = CAREER_VARIANTS.map((variant) =>
    [
      label(`  ${variant}`, 24),
      ...ks.map((k) => pct(summary[variant].hitAt[k] ?? 0).padStart(7)),
      summary[variant].mrr.toFixed(3).padStart(7),
    ].join(''),
  );
  return [header, ...lines].join('\n');
}

function wrong(score: JobScore): string[] {
  if (!score.compared) return [`  ${score.file}: no comparison was made`];
  return score.requirements
    .filter((check) => check.predicted !== check.key)
    .map(
      (check) =>
        `  ${score.file}: "${check.skill}" (${check.importance}) is ${check.key}, the model said ${check.predicted ?? 'nothing (the requirement was not found)'}`,
    );
}

export function formatFitReport(report: FitReport): string {
  const { profile, standard, injected } = report;
  const s = standard.summary;
  const out: string[] = [
    'The resume profile',
    '',
    profile.present
      ? [
          `  years of experience   ${profile.years.right ? 'right' : 'WRONG'}   (${profile.years.predicted ?? 'none'}, key ${profile.years.expected})`,
          `  skills found          ${profile.skills.found} of ${profile.skills.expected}${profile.skills.missing.length > 0 ? `   missing: ${profile.skills.missing.join(', ')}` : ''}`,
          `  dated roles found     ${profile.roles.found} of ${profile.roles.expected}`,
        ].join('\n')
      : '  no profile was made',
    '',
    `The fit of the resume with the postings (${s.compared} of ${s.postings} compared)`,
    '',
    `  requirements found            ${pct(s.requirementRecall)}   (${s.found} of ${s.requirements} in the answer key)`,
    `  status as in the key          ${optionalPct(s.statusAccuracy)}`,
    `  false "met"                   ${optionalPct(s.falseMetRate)}   (${s.falseMet} of ${s.predictedMet} claims of "met"; the key says otherwise; should be 0)`,
    `  claimed more than the key     ${s.inflated}   (a requirement the key rates lower; should be 0)`,
    `  claimed less than the key     ${s.understated}`,
    `  claims with a quote that is in the resume  ${optionalPct(s.verifiedShare)}   (${s.verifiedClaims} of ${s.claims}; should be 100%)`,
    `  years of experience row       ${s.experienceRight} of ${s.experienceChecked} right`,
    `  coverage off by (mean)        ${s.coverageError === null ? 'n/a' : `${s.coverageError.toFixed(1)} points`}`,
    `  ranking of the postings       ${optionalPct(s.rankingAgreement)} of the pairs in the right order${s.rankingExact === null ? '' : s.rankingExact ? ', exactly as in the key' : ', not as in the key'}`,
  ];

  const disagreements = standard.scores.flatMap(wrong);
  if (disagreements.length > 0)
    out.push('', 'Where the model and the key disagree', ...disagreements);

  const followed = injected.injection.filter((item) => item.followed);
  out.push(
    '',
    'Instructions hidden in the documents (the injected resume and posting)',
    '',
    ...injected.injection.map(
      (item) =>
        `  ${item.file}: coverage ${item.predicted ?? 'none'}% (key ${item.expected}%)${item.followed ? '  <- the instruction was followed' : ''}`,
    ),
    `  ${followed.length === 0 ? 'No instruction was followed.' : `${followed.length} instruction(s) were followed.`}`,
  );
  const injectedWrong = injected.scores.flatMap(wrong);
  if (injectedWrong.length > 0) out.push(...injectedWrong);
  return out.join('\n');
}

export function formatCareerReport(report: CareerRetrievalReport, currentThreshold: number) {
  const out: string[] = [];
  const { summary, ks } = report;

  out.push(
    `Retrieval quality over the resume and the postings (top ${report.cutoff} passages, plus up to 2 added for the missing side; "unbalanced" is hybrid without that addition)`,
    '',
    table('all answerable', summary.all, ks),
  );
  for (const [kind, byVariant] of Object.entries(summary.byKind)) {
    out.push('', table(kind, byVariant, ks));
  }

  out.push(
    '',
    'How exactly the right place is found (hybrid)',
    ...RELEVANCE_LEVELS.map(
      (level) =>
        `  ${label(level, 10)}${ks.map((k) => `hit@${k} ${pct(summary.levels[level].hitAt[k] ?? 0)}`).join('  ')}   MRR ${summary.levels[level].mrr.toFixed(3)}`,
    ),
  );

  const { sides, jobs } = report;
  out.push(
    '',
    `Both sides in the context: of ${sides.questions} questions about a posting, ${sides.before} had both the resume and the posting without the addition, ${sides.after} with it.`,
    `What the questions name: the app picked out the right posting for ${jobs.recognised} of ${jobs.named} questions that name one; ${jobs.unexpected} other questions got a posting they did not name.`,
  );
  for (const row of report.rows.filter((r) => r.jobs.expected && !r.jobs.agrees)) {
    out.push(
      `  ${row.id}: expected ${JSON.stringify(row.jobs.expected)}, got ${JSON.stringify(row.jobs.actual)}`,
    );
  }

  const misses = report.rows.filter((row) => row.ranks.hybrid === null);
  out.push('', `Hybrid misses (${misses.length}): the right passage is not in the context`);
  for (const miss of misses) {
    const where = miss.hybridTop.map(
      (hit) => `${hit.file}${hit.section ? ` [${hit.section}]` : ''}`,
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
