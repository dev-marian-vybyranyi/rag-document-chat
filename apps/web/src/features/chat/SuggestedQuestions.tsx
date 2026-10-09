import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useDocuments } from '@/features/documents/documents-context';
import { sourcesInScope } from './scope';
import { pickSuggestions } from './suggestions';

export function SuggestedQuestions({
  onPick,
  sourceIds = null,
}: {
  onPick: (question: string) => void;
  sourceIds?: string[] | null;
}) {
  const { state } = useDocuments();
  if (state.status !== 'ready') return null;

  const { documents } = state;
  if (documents.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        You have no documents yet.{' '}
        <Link to="/documents" className="font-medium text-foreground underline underline-offset-4">
          Add one
        </Link>{' '}
        to get answers from it, or import a code repository there.
      </p>
    );
  }

  if (sourceIds !== null && sourcesInScope(sourceIds, documents).length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        The sources chosen for this chat are gone. Choose others above.
      </p>
    );
  }

  const scoped = sourcesInScope(sourceIds, documents);
  const suggestions = pickSuggestions(scoped);
  if (suggestions.length === 0) {
    const waiting = scoped.some((doc) => doc.status === 'processing');
    return waiting ? (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        Your documents and repositories are still being processed. Questions will work once they are
        ready.
      </p>
    ) : null;
  }

  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">Try asking:</p>
      <ul className="mt-2 flex flex-col items-center gap-2" aria-label="Suggested questions">
        {suggestions.map((question) => (
          <li key={question} className="max-w-full">
            <Button
              variant="outline"
              size="sm"
              className="h-auto max-w-full py-1.5 text-left whitespace-normal"
              onClick={() => onPick(question)}
            >
              {question}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
