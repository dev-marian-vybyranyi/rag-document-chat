const STOPWORDS = new Set(
  (
    'a an the is are was were be been being am do does did done of in on at to for from by with ' +
    'as and or not no it its this that these those what where which who whom whose how why when ' +
    'can could should would will shall may might must i me my we our us you your he she they ' +
    'them there here about into over under than then so if any all some each every other ' +
    'use used uses using show tell explain give ' +
    'code file files function functions method methods implemented implement implementation ' +
    'defined define defines work works working happen happens'
  ).split(' '),
);

const MAX_TERMS = 24;

function splitCamelCase(word: string): string[] {
  return word
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ');
}

export function codeSearchTerms(text: string): string[] {
  const terms = new Set<string>();
  const add = (term: string) => {
    const lower = term.toLowerCase();
    if (lower.length < 2 || STOPWORDS.has(lower)) return;
    terms.add(lower);
  };

  for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    add(word);
    const parts = splitCamelCase(word);
    if (parts.length > 1) parts.forEach(add);
  }
  return [...terms].slice(0, MAX_TERMS);
}

export function toTsQueryOr(terms: string[]): string {
  return terms.join(' | ');
}
