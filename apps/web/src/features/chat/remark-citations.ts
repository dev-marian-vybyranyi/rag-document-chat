interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
}

interface Options {
  isSource: (id: number) => boolean;
}

const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

function text(value: string): MarkdownNode {
  return { type: 'text', value };
}

function citation(id: number): MarkdownNode {
  return {
    type: 'emphasis',
    data: { hName: 'cite', hProperties: { dataSource: id } },
    children: [text(`[${id}]`)],
  };
}

function split(value: string, isSource: Options['isSource']): MarkdownNode[] {
  const result: MarkdownNode[] = [];
  let last = 0;

  for (const match of value.matchAll(CITATION)) {
    const ids = match[1]!.split(',').map((part) => Number(part.trim()));
    if (!ids.every(isSource)) continue;

    if (match.index > last) result.push(text(value.slice(last, match.index)));
    result.push(...ids.map(citation));
    last = match.index + match[0].length;
  }

  if (result.length === 0) return [text(value)];
  if (last < value.length) result.push(text(value.slice(last)));
  return result;
}

function visit(node: MarkdownNode, isSource: Options['isSource']) {
  if (!node.children) return;

  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) return split(child.value, isSource);
    visit(child, isSource);
    return [child];
  });
}

export function remarkCitations({ isSource }: Options) {
  return (tree: MarkdownNode) => visit(tree, isSource);
}
