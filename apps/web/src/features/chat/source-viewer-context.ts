import { createContext, useContext } from 'react';
import type { ChatSource } from './types';

export interface SourceViewerContextValue {
  source: ChatSource | null;
  open: (source: ChatSource) => void;
  close: () => void;
}

export const SourceViewerContext = createContext<SourceViewerContextValue>({
  source: null,
  open: () => {},
  close: () => {},
});

export function useSourceViewer(): SourceViewerContextValue {
  return useContext(SourceViewerContext);
}
