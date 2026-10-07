import { MenuIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AppShellProps {
  headerRight?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppShell({ headerRight, sidebar, children }: AppShellProps) {
  const location = useLocation();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const sidebarOpen = openAt === location.key;

  return (
    <div className="flex h-screen flex-col bg-muted/40 text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4 md:px-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Show conversations"
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
            onClick={() => setOpenAt(sidebarOpen ? null : location.key)}
          >
            <MenuIcon aria-hidden />
          </Button>
          <h1 className="text-lg font-semibold tracking-tight whitespace-nowrap">Document Chat</h1>
        </div>
        {headerRight}
      </header>
      <div className="relative flex min-h-0 flex-1">
        <aside
          id="sidebar"
          className={cn(
            'absolute inset-y-0 left-0 z-10 w-72 border-r bg-background md:static md:block md:w-64 md:shrink-0',
            sidebarOpen ? 'block' : 'hidden',
          )}
        >
          {sidebar}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
