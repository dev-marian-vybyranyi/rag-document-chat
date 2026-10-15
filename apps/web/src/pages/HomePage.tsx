import { Loader2Icon, PlusIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useNewChat } from '@/features/chats/useNewChat';

export function HomePage() {
  const { open, creating, failed } = useNewChat();

  return (
    <div className="mx-auto max-w-3xl px-6 py-16 text-center">
      <h2 className="text-2xl font-semibold">Ask questions about your documents</h2>
      <p className="mt-3 text-muted-foreground">Pick a conversation or start a new one.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button onClick={open} disabled={creating}>
          {creating ? (
            <Loader2Icon className="animate-spin" aria-hidden />
          ) : (
            <PlusIcon aria-hidden />
          )}
          Start a new chat
        </Button>
        <Button variant="outline" asChild>
          <Link to="/documents">Add documents</Link>
        </Button>
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Could not start a new chat. Try again.
        </p>
      )}
    </div>
  );
}
