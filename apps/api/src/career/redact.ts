export interface RedactionCounts {
  emails: number;
  links: number;
  phones: number;
  addresses: number;
  attributeLines: number;
}

export interface Redaction {
  text: string;
  removed: RedactionCounts;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const LINK =
  /(?:\bhttps?:\/\/|\bwww\.|\b(?:[a-z0-9-]+\.)?(?:linkedin\.com|github\.com|gitlab\.com|bitbucket\.org|twitter\.com|x\.com|t\.me)\/)[^\s<>"')\]]+/gi;

const STREET_SUFFIX =
  'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Square|Sq';

const STREET_ADDRESS = new RegExp(
  `\\b\\d{1,5}[A-Za-z]?\\s+(?:[A-Z][\\w'.-]*\\s+){1,3}(?:${STREET_SUFFIX})\\b\\.?(?:,?\\s*(?:Apt|Apartment|Suite|Unit|Flat)\\.?\\s*\\w+)?`,
  'g',
);

const ADDRESS_LINE = /^\s*(?:[-•*]\s*)?(?:home\s+|postal\s+|mailing\s+)?address\s*[:\-–]/i;

const ATTRIBUTE_LABELS = [
  'date of birth',
  'dob',
  'd\\.o\\.b\\.?',
  'birth\\s?date',
  'birthday',
  'place of birth',
  'born',
  'age',
  'gender',
  'sex',
  'marital status',
  'family status',
  'nationality',
  'religion',
  'photo',
].join('|');

const LABELLED_ATTRIBUTE = new RegExp(
  `^\\s*(?:[-•*]\\s*)?(?:${ATTRIBUTE_LABELS})\\s*[:\\-–]\\s*\\S`,
  'i',
);
const UNLABELLED_BIRTH = /^\s*(?:[-•*]\s*)?(?:born(?:\s+on)?|date of birth)\s+\d/i;

const SEGMENT_SEPARATOR = /\s+[|•·]\s+/;

const PHONE_CANDIDATE = /(?<![\w.])\+?\(?\d[\d\s().-]{7,}\d(?![\w])/g;

const SPACED_PHONE_SHAPES = [
  /^\d{3} \d{3} \d{4}$/,
  /^\d{4} \d{3} \d{4}$/,
  /^\d{2}( \d{2}){4}$/,
  /^\d{5} \d{6}$/,
];

function isAttribute(line: string): boolean {
  return LABELLED_ATTRIBUTE.test(line) || UNLABELLED_BIRTH.test(line);
}

function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '').length;
  if (digits < 9 || digits > 15) return false;
  if (candidate.startsWith('+') || candidate.includes('(')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) return false;
  if (/^(?:19|20)\d{2}[-.]\d{2}[-.]\d{2}$/.test(candidate)) return false;
  if (/^\d{2}[-.]\d{2}[-.](?:19|20)\d{2}$/.test(candidate)) return false;
  if (/[-.]/.test(candidate)) {
    const groups = candidate.split(/[\s.-]+/);
    return groups.length >= 3 && groups.every((group) => group.length <= 4);
  }
  return SPACED_PHONE_SHAPES.some((shape) => shape.test(candidate));
}

function dropAttributes(text: string, counts: RedactionCounts): string {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (isAttribute(line)) {
      counts.attributeLines++;
      continue;
    }
    if (ADDRESS_LINE.test(line)) {
      counts.addresses++;
      continue;
    }
    if (SEGMENT_SEPARATOR.test(line)) {
      const segments = line.split(SEGMENT_SEPARATOR);
      const remaining = segments.filter((segment) => !isAttribute(segment));
      if (remaining.length < segments.length) {
        counts.attributeLines += segments.length - remaining.length;
        if (remaining.length === 0) continue;
        kept.push(remaining.join(' | '));
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function replaceAll(
  text: string,
  pattern: RegExp,
  placeholder: string,
  count: () => void,
  accept: (match: string) => boolean = () => true,
): string {
  return text.replace(pattern, (match) => {
    if (!accept(match)) return match;
    count();
    return placeholder;
  });
}

function keepTrailingPunctuation(match: string): { core: string; tail: string } {
  const tail = /[.,;:!?]+$/.exec(match)?.[0] ?? '';
  return { core: match.slice(0, match.length - tail.length), tail };
}

export function redactResume(text: string): Redaction {
  const removed: RedactionCounts = {
    emails: 0,
    links: 0,
    phones: 0,
    addresses: 0,
    attributeLines: 0,
  };

  let result = dropAttributes(text, removed);
  result = replaceAll(result, EMAIL, '[email]', () => removed.emails++);
  result = result.replace(LINK, (match) => {
    const { tail } = keepTrailingPunctuation(match);
    removed.links++;
    return `[link]${tail}`;
  });
  result = replaceAll(result, STREET_ADDRESS, '[address]', () => removed.addresses++);
  result = replaceAll(result, PHONE_CANDIDATE, '[phone]', () => removed.phones++, looksLikePhone);

  return { text: result, removed };
}
