import { Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FullPageMessage } from '@/components/FullPageMessage';
import { Button } from '@/components/ui/button';
import { useAuth } from './auth-context';

export const SLOW_START_MS = 4000;

export function LoadingScreen() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <FullPageMessage>
      <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">Loading…</p>
      {slow && (
        <p role="status" className="max-w-sm text-sm text-muted-foreground">
          This is taking longer than usual. The server may be waking up after a period of
          inactivity, which can take up to a minute.
        </p>
      )}
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
