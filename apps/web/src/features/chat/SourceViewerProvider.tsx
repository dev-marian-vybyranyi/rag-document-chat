import { useMemo, useState, type ReactNode } from 'react';
import {
  SourceViewerContext,
  type SourceViewerContextValue,
  type WhyData,
} from './source-viewer-context';
import type { ChatSource } from './types';

type Open = { kind: 'source'; source: ChatSource } | { kind: 'why'; why: WhyData } | null;

export function SourceViewerProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<Open>(null);

  const value = useMemo<SourceViewerContextValue>(
    () => ({
      source: panel?.kind === 'source' ? panel.source : null,
      why: panel?.kind === 'why' ? panel.why : null,
      open: (source) => setPanel({ kind: 'source', source }),
      openWhy: (why) => setPanel({ kind: 'why', why }),
      close: () => setPanel(null),
    }),
    [panel],
  );

  return <SourceViewerContext.Provider value={value}>{children}</SourceViewerContext.Provider>;
}
