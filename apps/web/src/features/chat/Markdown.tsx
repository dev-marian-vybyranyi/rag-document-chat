import { useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Citation } from './Citation';
import { CodeBlock } from './CodeBlock';
import { normalizeMarkdown } from './normalize-markdown';
import { remarkCitations } from './remark-citations';
import type { ChatSource } from './types';

export function Markdown({ children, sources }: { children: string; sources: ChatSource[] }) {
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(() => {
    const ids = new Set(sources.map((source) => source.id));
    return [remarkGfm, [remarkCitations, { isSource: (id: number) => ids.has(id) }]];
  }, [sources]);

  const components = useMemo<Components>(
    () => ({
      cite: ({ node: _node, ...props }) => {
        const id = Number((props as Record<string, unknown>)['data-source']);
        const source = sources.find((candidate) => candidate.id === id);
        return source ? <Citation source={source}>{props.children}</Citation> : props.children;
      },
      a: ({ node: _node, ...props }) => (
        <a
          {...props}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        />
      ),
      pre: ({ node: _node, children: content }) => <CodeBlock>{content}</CodeBlock>,
      code: ({ node: _node, className, children: content }) => (
        <code className={className ?? 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]'}>
          {content}
        </code>
      ),
      p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
      ul: ({ node: _node, ...props }) => (
        <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
      ),
      ol: ({ node: _node, ...props }) => (
        <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
      ),
      h1: ({ node: _node, ...props }) => (
        <h3 className="mt-4 mb-2 text-base font-semibold" {...props} />
      ),
      h2: ({ node: _node, ...props }) => (
        <h3 className="mt-4 mb-2 text-base font-semibold" {...props} />
      ),
      h3: ({ node: _node, ...props }) => <h4 className="mt-3 mb-1 font-semibold" {...props} />,
      h4: ({ node: _node, ...props }) => <h4 className="mt-3 mb-1 font-semibold" {...props} />,
      blockquote: ({ node: _node, ...props }) => (
        <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...props} />
      ),
      table: ({ node: _node, ...props }) => (
        <div className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs" {...props} />
        </div>
      ),
      th: ({ node: _node, ...props }) => (
        <th className="border-b bg-muted px-2 py-1 font-medium" {...props} />
      ),
      td: ({ node: _node, ...props }) => <td className="border-b px-2 py-1" {...props} />,
      hr: () => <hr className="my-3" />,
    }),
    [sources],
  );

  return (
    <div className="break-words">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {normalizeMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
}
