import type { DocumentItem } from '../documents/api';

export interface ScopeDescription {
  label: string;
  missing: number;
  empty: boolean;
}

export const idsOf = (library: DocumentItem[]) => library.map((source) => source.id);

export function liveIds(sourceIds: string[], library: DocumentItem[]): string[] {
  const known = new Set(idsOf(library));
  return sourceIds.filter((id) => known.has(id));
}

export function normalizeScope(selected: string[], library: DocumentItem[]): string[] | null {
  const chosen = new Set(selected);
  return library.length > 0 && library.every((source) => chosen.has(source.id)) ? null : selected;
}

export function sourcesInScope(
  sourceIds: string[] | null,
  library: DocumentItem[],
): DocumentItem[] {
  if (sourceIds === null) return library;
  const chosen = new Set(sourceIds);
  return library.filter((source) => chosen.has(source.id));
}

export function describeScope(
  sourceIds: string[] | null,
  library: DocumentItem[],
): ScopeDescription {
  if (sourceIds === null) return { label: 'All sources', missing: 0, empty: false };
  const live = sourcesInScope(sourceIds, library);
  const missing = sourceIds.length - live.length;
  if (live.length === 0) return { label: 'Chosen sources deleted', missing, empty: true };
  const label = live.length === 1 ? live[0]!.filename : `${live.length} sources`;
  return { label, missing, empty: false };
}
