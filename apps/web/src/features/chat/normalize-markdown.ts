const FENCE_WITH_CITATION =
  /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*(\[\d{1,2}(?:\s*,\s*\d{1,2})*\](?:\[\d{1,2}\])*)[ \t]*$/gm;

export function normalizeMarkdown(text: string): string {
  return text.replace(FENCE_WITH_CITATION, '$1$2\n\n$3');
}
