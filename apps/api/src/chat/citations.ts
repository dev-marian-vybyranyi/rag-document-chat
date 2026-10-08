import type { TextStreamPart, ToolSet } from 'ai';

export interface CitationStats {
  kept: number;
  removed: number;
}

const CITATION_CONTENT = /^\d{1,2}(?:\s*,\s*\d{1,2})*$/;
const MAX_PENDING_CHARS = 20;
const CITATION_CHARS = /[\d, ]/;
const CLOSES_LINE_OR_SENTENCE = /[.,;:!?)\n]/;
const WORD_CHAR = /[\p{L}\p{N}_)]/u;

export function createCitationFilter(isSource: (id: number) => boolean) {
  const stats: CitationStats = { kept: 0, removed: 0 };
  let fenced = false;
  let inlineCode = false;
  let ticks = 0;
  let pending: string | null = null;
  let held = '';
  let last = '';
  let justDropped = false;
  let inIndex = false;
  let afterIndex = false;
  let out = '';

  const write = (char: string) => {
    if (char === ' ' || char === '\t') {
      if (justDropped && held) return;
      held += char;
      return;
    }
    if (justDropped && CLOSES_LINE_OR_SENTENCE.test(char)) held = '';
    out += held + char;
    held = '';
    last = char;
    justDropped = false;
  };

  const writeAll = (text: string) => {
    for (const char of text) write(char);
  };

  const flushPending = () => {
    if (pending === null) return;
    const text = pending;
    pending = null;
    writeAll(text);
  };

  const settleTicks = () => {
    if (ticks >= 3) fenced = !fenced;
    else if (!fenced) inlineCode = !inlineCode;
    ticks = 0;
  };

  const resolvePending = () => {
    const text = pending!;
    pending = null;
    const content = text.slice(1, -1);
    if (!CITATION_CONTENT.test(content)) {
      writeAll(text);
      return;
    }
    const ids = content.split(',').map(Number);
    const valid = ids.filter(isSource);
    stats.kept += valid.length;
    stats.removed += ids.length - valid.length;
    if (valid.length === ids.length) writeAll(text);
    else if (valid.length > 0) writeAll(`[${valid.join(', ')}]`);
    else justDropped = true;
  };

  const step = (char: string) => {
    if (char === '`') {
      flushPending();
      ticks++;
      write(char);
      return;
    }
    if (ticks > 0) settleTicks();

    if (fenced || inlineCode) {
      if (char === '\n') inlineCode = false;
      write(char);
      return;
    }

    if (pending !== null) {
      if (char === '[') {
        flushPending();
        pending = '[';
        return;
      }
      pending += char;
      if (char === ']') resolvePending();
      else if (!CITATION_CHARS.test(char) || pending.length > MAX_PENDING_CHARS) flushPending();
      return;
    }

    if (char === '[') {
      if (held === '' && (WORD_CHAR.test(last) || afterIndex)) {
        inIndex = true;
        write(char);
      } else {
        pending = '[';
      }
      return;
    }
    if (inIndex && char === ']') {
      inIndex = false;
      afterIndex = true;
    } else if (!inIndex) {
      afterIndex = false;
    }
    write(char);
  };

  return {
    stats,
    push(text: string): string {
      out = '';
      for (const char of text) step(char);
      return out;
    },
    flush(): string {
      out = '';
      flushPending();
      if (!justDropped) out += held;
      held = '';
      return out;
    },
  };
}

export function filterCitations(text: string, isSource: (id: number) => boolean): string {
  const filter = createCitationFilter(isSource);
  return filter.push(text) + filter.flush();
}

export function createCitationStream(isSource: (id: number) => boolean) {
  const filter = createCitationFilter(isSource);
  const transform = new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
    transform(part, controller) {
      if (part.type === 'text-delta') {
        const text = filter.push(part.text);
        if (text) controller.enqueue({ ...part, text });
        return;
      }
      if (part.type === 'text-end') {
        const rest = filter.flush();
        if (rest) controller.enqueue({ type: 'text-delta', id: part.id, text: rest });
      }
      controller.enqueue(part);
    },
  });
  return { transform, stats: filter.stats };
}
