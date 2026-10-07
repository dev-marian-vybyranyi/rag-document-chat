export function escapeMarkup(text: string): string {
  return text.replace(/[<＜﹤]/g, '&lt;').replace(/[>＞﹥]/g, '&gt;');
}

export function escapeAttribute(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
