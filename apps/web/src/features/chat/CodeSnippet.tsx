import { cn } from '@/lib/utils';
import { highlight, type TokenKind } from './highlight';

const KIND_CLASSES: Record<TokenKind, string> = {
  keyword: 'text-violet-700 dark:text-violet-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  comment: 'text-muted-foreground italic',
  number: 'text-amber-700 dark:text-amber-300',
  plain: '',
};

interface CodeSnippetProps {
  code: string;
  language: string | null;
  startLine: number;
  label: string;
  className?: string;
}

export function CodeSnippet({ code, language, startLine, label, className }: CodeSnippetProps) {
  const lines = highlight(code, language);

  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn('overflow-x-auto rounded-md font-mono text-xs leading-relaxed', className)}
    >
      <pre className="min-w-max py-1.5">
        <code>
          {lines.map((tokens, index) => (
            <span key={index} className="flex" data-line={startLine + index}>
              <span
                aria-hidden
                className="w-10 shrink-0 pr-3 text-right text-muted-foreground tabular-nums select-none"
              >
                {startLine + index}
              </span>
              <span className="pr-3 whitespace-pre">
                {tokens.length === 0
                  ? ' '
                  : tokens.map((token, position) => (
                      <span key={position} className={KIND_CLASSES[token.kind]}>
                        {token.text}
                      </span>
                    ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
