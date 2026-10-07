export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const CITATION_MARKER = String.raw`\[[1-9]\d?(?:\s*,\s*[1-9]\d?)*\]`;
const CITATION_MARKERS = new RegExp(
  String.raw`\s*(?<![^\s.!?,;:)"'])${CITATION_MARKER}(?:\s*${CITATION_MARKER})*`,
  'g',
);

export function stripCitations(text: string): string {
  return text
    .replace(CITATION_MARKERS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function recentTurns(
  history: ChatTurn[],
  limits: { maxTurns: number; maxCharsPerTurn: number },
): ChatTurn[] {
  return history
    .slice(-limits.maxTurns)
    .map((turn) => ({
      role: turn.role,
      content: truncate(
        turn.role === 'assistant' ? stripCitations(turn.content) : turn.content.trim(),
        limits.maxCharsPerTurn,
      ),
    }))
    .filter((turn) => turn.content.length > 0);
}
