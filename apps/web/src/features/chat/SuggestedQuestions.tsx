import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useDocuments } from '@/features/documents/documents-context';
import { pickSuggestions } from './suggestions';

export function SuggestedQuestions({ onPick }: { onPick: (question: string) => void }) {
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
        to get answers from it.
      </p>
    );
  }

  const suggestions = pickSuggestions(documents);
  if (suggestions.length === 0) {
    const waiting = documents.some((doc) => doc.status === 'processing');
    return waiting ? (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        Your documents are still being processed. Questions will work once they are ready.
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
