import { Component, type ReactNode } from 'react';
import { FullPageMessage } from '@/components/FullPageMessage';
import { Button } from '@/components/ui/button';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <FullPageMessage>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          The page hit an unexpected error. Your conversations are safe; reloading usually fixes it.
        </p>
        <Button onClick={() => window.location.reload()}>Reload the page</Button>
      </FullPageMessage>
    );
  }
}
