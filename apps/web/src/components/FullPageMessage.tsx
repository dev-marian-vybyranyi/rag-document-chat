import type { ReactNode } from 'react';

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/40 p-6 text-center">
      {children}
    </div>
  );
}
