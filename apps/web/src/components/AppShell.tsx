import type { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex h-14 shrink-0 items-center border-b border-slate-200 bg-white px-6">
        <h1 className="text-lg font-semibold tracking-tight">Document Chat</h1>
      </header>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
