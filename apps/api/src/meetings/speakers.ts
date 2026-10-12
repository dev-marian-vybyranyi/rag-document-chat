import { stripInvisibleCharacters } from '../rag/sanitize.js';

export const MAX_SPEAKER_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 6;
const MAX_HEADER_NAME_WORDS = 4;

export const NAME_SOURCE = String.raw`[^:\[\]()<>]{1,${MAX_SPEAKER_NAME_LENGTH}}?`;

export function cleanSpeakerName(raw: string, options: { header?: boolean } = {}): string | null {
  const name = stripInvisibleCharacters(raw).replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > MAX_SPEAKER_NAME_LENGTH) return null;
  if (!/\p{L}/u.test(name)) return null;
  const words = name.split(' ').length;
  if (words > (options.header ? MAX_HEADER_NAME_WORDS : MAX_NAME_WORDS)) return null;
  if (options.header && /[.!?,;]$/.test(name)) return null;
  return name;
}

export function createSpeakerRegistry() {
  const byKey = new Map<string, string>();
  return {
    canonical(name: string): string {
      const key = name.toLocaleLowerCase();
      const known = byKey.get(key);
      if (known !== undefined) return known;
      byKey.set(key, name);
      return name;
    },
    names: () => [...byKey.values()],
  };
}
