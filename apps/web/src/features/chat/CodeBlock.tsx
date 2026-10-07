import { CheckIcon, CopyIcon } from 'lucide-react';
import { Children, isValidElement, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

const COPIED_MS = 2000;

function codeOf(children: ReactNode): { text: string; language: string | null } {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return { text: '', language: null };
  }
  const language = /language-([\w+#-]+)/.exec(child.props.className ?? '')?.[1] ?? null;
  const raw = Children.toArray(child.props.children).join('');
  return { text: raw.replace(/\n$/, ''), language };
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const { text, language } = codeOf(children);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border bg-muted/60">
      <div className="flex items-center justify-between border-b bg-muted px-3 py-1">
        <span className="text-xs text-muted-foreground">{language ?? 'text'}</span>
        <Button variant="ghost" size="xs" onClick={copy} aria-label="Copy code">
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-[0.85em] leading-relaxed">
        <code className="font-mono">{text}</code>
      </pre>
    </div>
  );
}
