import { MenuIcon } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const DESKTOP_QUERY = '(min-width: 768px)';

function subscribeToDesktop(onChange: () => void) {
  const query = matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function useIsDesktop() {
  return useSyncExternalStore(
    subscribeToDesktop,
    () => matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

interface AppShellProps {
  headerRight?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppShell({ headerRight, sidebar, children }: AppShellProps) {
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const firstRoute = useRef(location.key);
  const sidebarOpen = openAt === location.key;
  const drawerOpen = sidebarOpen && !isDesktop;

  useEffect(() => {
    if (!drawerOpen) return;
    drawer.current?.querySelector<HTMLElement>('a, button')?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setOpenAt(null);
      toggle.current?.focus();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen]);

  useEffect(() => {
    if (location.key === firstRoute.current) return;
    const active = document.activeElement;
    if (active === document.body || drawer.current?.contains(active)) {
      main.current?.focus({ preventScroll: true });
    }
  }, [location.key]);

  function skipToContent(event: MouseEvent) {
    event.preventDefault();
    main.current?.focus();
  }

  return (
    <div className="flex h-dvh flex-col bg-muted/40 text-foreground">
      <a
        href="#main"
        onClick={skipToContent}
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-ring focus:outline-none"
      >
        Skip to main content
      </a>
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-4 md:px-6">
        <div className="flex items-center gap-2">
          <Button
            ref={toggle}
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
        {drawerOpen && (
          <div
            aria-hidden
            data-testid="sidebar-scrim"
            className="absolute inset-0 z-[5] bg-black/40"
            onClick={() => setOpenAt(null)}
          />
        )}
        <aside
          ref={drawer}
          id="sidebar"
          className={cn(
            'absolute inset-y-0 left-0 z-10 w-72 border-r bg-background md:static md:block md:w-64 md:shrink-0',
            sidebarOpen ? 'block' : 'hidden',
          )}
        >
          {sidebar}
        </aside>
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          inert={drawerOpen}
          className="min-w-0 flex-1 overflow-y-auto outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
