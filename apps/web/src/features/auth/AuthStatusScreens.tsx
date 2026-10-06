import { Loader2Icon } from 'lucide-react';
import { FullPageMessage } from '@/components/FullPageMessage';
import { Button } from '@/components/ui/button';
import { useAuth } from './auth-context';

export function LoadingScreen() {
  return (
    <FullPageMessage>
      <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">Loading…</p>
    </FullPageMessage>
  );
}

/** Shown when the API cannot be reached, which on free hosting usually means it is waking up. */
export function UnavailableScreen() {
  const { reload } = useAuth();
  return (
    <FullPageMessage>
      <h1 className="text-lg font-semibold">The server is not responding</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        It may still be waking up after a period of inactivity. This can take up to a minute.
      </p>
      <Button onClick={reload}>Try again</Button>
    </FullPageMessage>
  );
}
