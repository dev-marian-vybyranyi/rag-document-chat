import { XIcon } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface SidePanelProps {
  label: string;
  title: string;
  subtitle: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

export function SidePanel({
  label,
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
}: SidePanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  return (
    <aside
      aria-label={label}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      className="fixed top-14 right-0 bottom-0 z-30 flex w-full flex-col border-l bg-background shadow-xl sm:w-96 xl:static xl:z-auto xl:shrink-0 xl:shadow-none"
    >
      <header className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" title={title}>
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <Button
          ref={closeButton}
          variant="ghost"
          size="icon-sm"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
    </aside>
  );
}
