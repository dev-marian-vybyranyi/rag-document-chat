import { useMemo, useState, type ReactNode } from 'react';
import { SourceViewerContext, type SourceViewerContextValue } from './source-viewer-context';
import type { ChatSource } from './types';

export function SourceViewerProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<ChatSource | null>(null);

  const value = useMemo<SourceViewerContextValue>(
    () => ({ source, open: setSource, close: () => setSource(null) }),
    [source],
  );

  return <SourceViewerContext.Provider value={value}>{children}</SourceViewerContext.Provider>;
}
