import { describe, expect, it } from 'vitest';
import { remarkCitations } from './remark-citations';

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
}

const text = (value: string): Node => ({ type: 'text', value });
const parent = (type: string, ...children: Node[]): Node => ({ type, children });

function run(tree: Node, sources: number[] = [1, 2, 3]) {
  remarkCitations({ isSource: (id) => sources.includes(id) })(tree);
  return tree;
}

const describeNode = (node: Node): string =>
  node.type === 'text'
    ? `"${node.value}"`
    : node.type === 'emphasis' && node.data?.hName === 'cite'
      ? `cite${node.data.hProperties ? (node.data.hProperties as { dataSource: number }).dataSource : '?'}`
      : `${node.type}(${(node.children ?? []).map(describeNode).join(' ')})`;

const paragraph = (value: string, sources?: number[]) =>
  run(parent('root', parent('paragraph', text(value))), sources).children![0]!.children!.map(
    describeNode,
  );

describe('remarkCitations', () => {
  it('splits a text around a known source number', () => {
    expect(paragraph('It is a graph [1] indeed.')).toEqual([
      '"It is a graph "',
      'cite1',
      '" indeed."',
    ]);
  });

  it('turns several markers into several citations, with no empty text between them', () => {
    expect(paragraph('Both [1][2].')).toEqual(['"Both "', 'cite1', 'cite2', '"."']);
  });

  it('turns a list into one citation per number', () => {
    expect(paragraph('Both [1, 3].')).toEqual(['"Both "', 'cite1', 'cite3', '"."']);
  });

  it('works at the very start and the very end of a text', () => {
    expect(paragraph('[1] starts')).toEqual(['cite1', '" starts"']);
    expect(paragraph('ends [2]')).toEqual(['"ends "', 'cite2']);
    expect(paragraph('[1]')).toEqual(['cite1']);
  });

  it('is all or nothing for a list: one unknown number leaves the whole marker as text', () => {
    expect(paragraph('Claim [1, 9].')).toEqual(['"Claim [1, 9]."']);
  });

  it('does not touch a number that is not a source, but still reads the others around it', () => {
    expect(paragraph('A [9] and B [2].')).toEqual(['"A [9] and B "', 'cite2', '"."']);
  });

  it.each(['[100]', '[1-3]', '[a]', '[]', '[1,]', '[ 1 ]', 'items[1x]', '[ [1'])(
    'leaves %s as plain text',
    (marker) => {
      expect(paragraph(`See ${marker} here`)).toEqual([`"See ${marker} here"`]);
    },
  );

  it('does not read a number with spaces before the comma as two separate markers', () => {
    expect(paragraph('Both [1 , 2].')).toEqual(['"Both "', 'cite1', 'cite2', '"."']);
  });

  it('leaves a text without any marker as it was, even when it is empty', () => {
    expect(paragraph('Nothing here.')).toEqual(['"Nothing here."']);
    expect(paragraph('')).toEqual(['""']);
  });

  it('finds markers in every kind of container', () => {
    const tree = run(
      parent(
        'root',
        parent('heading', text('Title [1]')),
        parent('blockquote', parent('paragraph', text('Quote [2]'))),
        parent('list', parent('listItem', parent('paragraph', text('Item [3]')))),
        parent('table', parent('tableRow', parent('tableCell', text('Cell [1]')))),
        parent('paragraph', parent('strong', text('Bold [2]'))),
      ),
    );

    const found = JSON.stringify(tree).match(/"dataSource":\d/g);
    expect(found).toEqual([
      '"dataSource":1',
      '"dataSource":2',
      '"dataSource":3',
      '"dataSource":1',
      '"dataSource":2',
    ]);
  });

  it('does not read code: neither a code block nor inline code carries children to visit', () => {
    const tree = run(
      parent(
        'root',
        { type: 'code', value: 'const a = [1];' },
        parent('paragraph', { type: 'inlineCode', value: 'a[2]' }),
      ),
    );

    expect(JSON.stringify(tree)).not.toContain('dataSource');
    expect(tree.children![0]!.value).toBe('const a = [1];');
  });

  it('marks each citation as emphasis that renders as a cite element with its source number', () => {
    const tree = run(parent('root', parent('paragraph', text('A [2]'))));

    const cite = tree.children![0]!.children![1]!;
    expect(cite).toMatchObject({
      type: 'emphasis',
      data: { hName: 'cite', hProperties: { dataSource: 2 } },
      children: [{ type: 'text', value: '[2]' }],
    });
  });

  it('does nothing when there are no sources at all', () => {
    expect(paragraph('Claim [1].', [])).toEqual(['"Claim [1]."']);
  });
});
