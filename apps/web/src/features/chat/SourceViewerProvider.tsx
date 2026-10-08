import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  SourceViewerContext,
  type SourceViewerContextValue,
  type WhyData,
} from './source-viewer-context';
import type { ChatSource } from './types';

type Open = { kind: 'source'; source: ChatSource } | { kind: 'why'; why: WhyData } | null;

export function SourceViewerProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<Open>(null);
  const opener = useRef<HTMLElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const remember = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  useEffect(() => {
    if (panel !== null) return;
    const target = returnTo.current;
    returnTo.current = null;
    if (target?.isConnected) target.focus();
  }, [panel]);

  const value = useMemo<SourceViewerContextValue>(
    () => ({
      source: panel?.kind === 'source' ? panel.source : null,
      why: panel?.kind === 'why' ? panel.why : null,
      open: (source) => {
        remember();
        setPanel({ kind: 'source', source });
      },
      openWhy: (why) => {
        remember();
        setPanel({ kind: 'why', why });
      },
      close: () => {
        returnTo.current = opener.current;
        setPanel(null);
      },
    }),
    [panel],
  );

  return <SourceViewerContext.Provider value={value}>{children}</SourceViewerContext.Provider>;
}
