import type { DocumentItem } from '../documents/api';
import { suggestionsOf } from '../documents/meeting-questions';

export const MAX_SUGGESTIONS = 4;

export function pickSuggestions(documents: DocumentItem[]): string[] {
  const lists = documents
    .filter((doc) => doc.status === 'ready')
    .map(suggestionsOf)
    .filter((list) => list.length > 0);

  const picked: string[] = [];
  for (let round = 0; picked.length < MAX_SUGGESTIONS; round++) {
    const row = lists.flatMap((list) => (round < list.length ? [list[round]!] : []));
    if (row.length === 0) break;
    for (const question of row) {
      if (picked.length < MAX_SUGGESTIONS && !picked.includes(question)) picked.push(question);
    }
  }
  return picked;
}
