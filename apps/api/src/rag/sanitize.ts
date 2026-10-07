const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0xad, 0xad],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const DECEPTIVE_RANGES: Array<[number, number]> = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
];

const inRanges = (ranges: Array<[number, number]>, codePoint: number) =>
  ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

export function stripInvisibleCharacters(text: string): string {
  let result = '';
  for (const char of text) {
    if (!inRanges(INVISIBLE_RANGES, char.codePointAt(0)!)) result += char;
  }
  return result;
}

const SIGNALS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'override-instructions',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompts?|guidelines?)\b/i,
  },
  {
    name: 'role-reassignment',
    pattern: /\byou are (?:now (?:an?|the|my|in)|no longer)\b|\bfrom now on,? you\b/i,
  },
  {
    name: 'fake-message-boundary',
    pattern: /<\/?\s*(?:system|instructions?|sources?|assistant)\b|^\s*(?:system|developer)\s*:/im,
  },
  {
    name: 'prompt-extraction',
    pattern:
      /\b(?:reveal|print|show|repeat|output|leak)\b[^.\n]{0,40}\b(?:system prompt|(?:your|the) (?:instructions|rules|prompt))\b/i,
  },
  { name: 'image-exfiltration', pattern: /!\[[^\]]*\]\(\s*(?:https?:)?\/\//i },
];

export function findInjectionSignals(text: string): string[] {
  const found = SIGNALS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
  for (const char of text) {
    if (inRanges(DECEPTIVE_RANGES, char.codePointAt(0)!)) {
      found.push('hidden-text');
      break;
    }
  }
  return found;
}
