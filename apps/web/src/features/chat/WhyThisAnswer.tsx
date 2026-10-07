import { cn } from '@/lib/utils';
import { SidePanel } from './SidePanel';
import { citedIds } from './citations';
import { formatDuration, formatPercent } from './source-format';
import { useSourceViewer, type WhyData } from './source-viewer-context';

export function WhyThisAnswer() {
  const { why, close } = useSourceViewer();
  if (!why) return null;

  const declined = why.retrieval.outcome === 'declined';
  return (
    <SidePanel
      label="Why this answer"
      title="Why this answer?"
      subtitle={declined ? 'No answer was given' : 'How the answer was put together'}
      closeLabel="Close explanation"
      onClose={close}
    >
      <WhyContent data={why} />
    </SidePanel>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b pb-4 last:border-b-0">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="flex flex-col gap-2 text-sm">{children}</div>
    </section>
  );
}

export function WhyContent({ data }: { data: WhyData }) {
  const { question, answer, sources, retrieval } = data;
  const declined = retrieval.outcome === 'declined';
  const cited = citedIds(answer);

  return (
    <div className="flex flex-col gap-4">
      <Section title="How your question was searched">
        <p>
          <span className="text-muted-foreground">You asked: </span>
          {question}
        </p>
        {retrieval.rewritten ? (
          <>
            <p>
              <span className="text-muted-foreground">Searched for: </span>
              {retrieval.query}
            </p>
            <p className="text-xs text-muted-foreground">
              Your question was rewritten using the earlier conversation, so that words like “it”
              point to something the search can find.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">It was searched exactly as you wrote it.</p>
        )}
        <p>
          <span className="text-muted-foreground">Search: </span>
          {retrieval.mode === 'hybrid'
            ? 'by meaning and by keywords, combined'
            : 'by keywords only (the embedding service was unavailable, so there are no similarity scores)'}
        </p>
        {retrieval.timings && (
          <p className="text-xs text-muted-foreground">
            Rewriting took {formatDuration(retrieval.timings.rewriteMs)}, searching took{' '}
            {formatDuration(retrieval.timings.retrievalMs)}.
          </p>
        )}
      </Section>

      <Section title="Was anything relevant enough?">
        <Relevance retrieval={retrieval} />
      </Section>

      {declined ? (
        <Section title="Closest passages (not used)">
          {retrieval.closest && retrieval.closest.length > 0 ? (
            <ol className="flex flex-col gap-1.5">
              {retrieval.closest.map((passage, index) => (
                <li key={index} className="rounded-md border px-2.5 py-1.5">
                  <span className="font-medium">{passage.filename}</span>
                  {passage.page !== null && (
                    <span className="text-muted-foreground"> · page {passage.page}</span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    Similarity {formatPercent(passage.score)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">No passages were found at all.</p>
          )}
        </Section>
      ) : (
        <Section title="Passages the model was given">
          <ol className="flex flex-col gap-2">
            {sources.map((source) => {
              const used = cited.has(source.id);
              return (
                <li key={source.id} className="rounded-md border px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 break-words">
                      <span className="font-medium">[{source.id}]</span> {source.filename}
                      {source.page !== null && (
                        <span className="text-muted-foreground"> · page {source.page}</span>
                      )}
                    </p>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-xs',
                        used
                          ? 'bg-amber-100 text-foreground dark:bg-amber-400/15'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {used ? 'Cited' : 'Not cited'}
                    </span>
                  </div>
                  <ScoreLine source={source} />
                </li>
              );
            })}
          </ol>
        </Section>
      )}

      <p className="text-xs text-muted-foreground">
        Similarity is how close the passage is in meaning to the question (higher is closer).
        Keyword match is full-text relevance. A passage is ranked in each list, and the two rankings
        are merged into one combined score.
      </p>
    </div>
  );
}

function Relevance({ retrieval }: { retrieval: WhyData['retrieval'] }) {
  const { bestScore, threshold, mode, outcome } = retrieval;

  if (mode === 'keyword-only') {
    return (
      <p>
        Relevance could not be measured without similarity scores, so the passages that matched the
        words were handed to the model, which is told to say so if they do not answer.
      </p>
    );
  }
  if (bestScore === null) {
    return <p>Nothing in your documents matched the question.</p>;
  }

  const passed = outcome === 'answered';
  return (
    <>
      {threshold !== undefined && (
        <div
          role="img"
          aria-label={`Best similarity ${formatPercent(bestScore)}, required ${formatPercent(threshold)}`}
          className="relative h-2 rounded-full bg-muted"
        >
          <div
            className={cn('h-full rounded-full', passed ? 'bg-primary' : 'bg-destructive')}
            style={{ width: `${Math.min(100, Math.max(0, bestScore * 100))}%` }}
          />
          <div
            className="absolute -top-1 h-4 w-0.5 bg-foreground"
            style={{ left: `${Math.min(100, Math.max(0, threshold * 100))}%` }}
          />
        </div>
      )}
      <p>
        Best match {formatPercent(bestScore)}
        {threshold !== undefined && <>, at least {formatPercent(threshold)} is needed</>}.{' '}
        {passed
          ? 'That was enough to ask the model.'
          : 'That was not enough, so the model was not asked and no sources were shown.'}
      </p>
    </>
  );
}

function ScoreLine({ source }: { source: WhyData['sources'][number] }) {
  const parts: string[] = [];
  if (source.score !== null) {
    parts.push(
      `Similarity ${formatPercent(source.score)}${source.vectorRank ? ` (rank ${source.vectorRank})` : ''}`,
    );
  }
  if (source.keywordScore !== null && source.keywordScore !== undefined) {
    parts.push(
      `Keyword match ${source.keywordScore.toFixed(2)}${source.keywordRank ? ` (rank ${source.keywordRank})` : ''}`,
    );
  }
  if (source.fusedScore !== undefined) parts.push(`Combined ${source.fusedScore.toFixed(4)}`);

  if (parts.length === 0) {
    return <p className="mt-1 text-xs text-muted-foreground">Detailed scores were not recorded.</p>;
  }
  return <p className="mt-1 text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}
