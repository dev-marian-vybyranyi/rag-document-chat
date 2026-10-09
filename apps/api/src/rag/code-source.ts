export interface CodeSource {
  path: string;
  language: string | null;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}
