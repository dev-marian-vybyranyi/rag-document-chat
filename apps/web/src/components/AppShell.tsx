import type { ReactNode } from 'react';

interface AppShellProps {
  headerRight?: ReactNode;
  children: ReactNode;
}

export function AppShell({ headerRight, children }: AppShellProps) {
  return (
    <div className="flex h-screen flex-col bg-muted/40 text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-6">
        <h1 className="text-lg font-semibold tracking-tight">Document Chat</h1>
        {headerRight}
      </header>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
