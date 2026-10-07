const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

export function citedIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const match of text.matchAll(CITATION)) {
    for (const part of match[1]!.split(',')) ids.add(Number(part.trim()));
  }
  return ids;
}
