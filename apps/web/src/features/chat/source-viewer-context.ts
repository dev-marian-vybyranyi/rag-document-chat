import { createContext, useContext } from 'react';
import type { ChatRetrieval, ChatSource } from './types';

export interface WhyData {
  question: string;
  answer: string;
  sources: ChatSource[];
  retrieval: ChatRetrieval;
}

export interface SourceViewerContextValue {
  source: ChatSource | null;
  why: WhyData | null;
  open: (source: ChatSource) => void;
  openWhy: (data: WhyData) => void;
  close: () => void;
}

export const SourceViewerContext = createContext<SourceViewerContextValue>({
  source: null,
  why: null,
  open: () => {},
  openWhy: () => {},
  close: () => {},
});

export function useSourceViewer(): SourceViewerContextValue {
  return useContext(SourceViewerContext);
}
