/**
 * Text that spells a tag the editor handles is a fixed point of the write.
 *
 * `<b>x</b>` typed as text, or left as text by the nesting cap, was written as
 * it is and read back as a bold run, which lost the characters. The writer now
 * escapes the `<` of such a spelling (`\<b>x\</b>`), and the reader reads a
 * backslash before a handled tag as an escaped angle bracket: literal tag text,
 * the backslash gone. A backslash before a tag the editor does not handle is
 * text, as it was.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  blocksToYFragment,
  markdownToYFragment,
  yDocToCanonicalMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

interface Run {
  type: string
  text?: string
  styles?: Record<string, unknown>
}

async function read(markdown: string): Promise<Block[]> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
}

/** The markdown a document of `blocks` is written as. */
async function write(blocks: Block[]): Promise<string> {
  const doc = new Y.Doc()
  expect(blocksToYFragment(blocks, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return yDocToCanonicalMarkdown(doc)
}

const paragraph = (runs: Run[]): Block =>
  ({ id: 'p', type: 'paragraph', props: {}, content: runs, children: [] }) as unknown as Block

const typed = (text: string, styles: Record<string, unknown> = {}): Block =>
  paragraph([{ type: 'text', text, styles }])

const runsOf = (blocks: Block[]): Run[] =>
  blocks.flatMap((block) =>
    Array.isArray(block.content) ? (block.content as unknown as Run[]) : []
  )

const textOf = (blocks: Block[]): string =>
  runsOf(blocks)
    .map((run) => run.text ?? '')
    .join('')

const HANDLED_SPELLINGS = [
  '<b>x</b>',
  '<strong>x</strong>',
  '<i>x</i>',
  '<em>x</em>',
  '<u>x</u>',
  '<s>x</s>',
  '<del>x</del>',
  '<strike>x</strike>',
  '<code>x</code>',
  '<a href="u">x</a>',
  '<img src=x>',
  '<br>',
  '<br/>',
  '<hr>',
  '<figure><img src=x><figcaption>c</figcaption></figure>',
  '<video src=x></video>',
  '<h2>x</h2>',
  '<blockquote>x</blockquote>',
  '<pre><code>x</code></pre>',
  '<ul><li>x</li></ul>',
  '<ol><li>x</li></ol>',
  '<table><tr><td>x</td></tr></table>',
  '<details data-memry-toggle>x</details>',
  '<input type="checkbox">'
]

describe('a backslash before a tag the editor handles', () => {
  it('reads as an escaped angle bracket: the tag is text', async () => {
    const blocks = await read('\\<b>x\\</b>')
    expect(blocks).toHaveLength(1)
    expect(runsOf(blocks)).toEqual([{ type: 'text', text: '<b>x</b>', styles: {} }])
  })

  it.each(HANDLED_SPELLINGS)('keeps %s as the text it spells', async (spelling) => {
    const escaped = spelling.replace(/</g, '\\<')
    const blocks = await read(`a ${escaped} b`)
    expect(blocks).toHaveLength(1)
    expect(textOf(blocks)).toBe(`a ${spelling} b`)
    for (const run of runsOf(blocks)) expect(run.type).toBe('text')
  })

  it.each(['<kq>', '</kq>', '<kbd>x</kbd>', '<x a="*">', '<div>', '<span>x</span>'])(
    'is kept with %s, which the editor does not handle',
    async (spelling) => {
      const blocks = await read(`\\${spelling}`)
      expect(textOf(blocks)).toBe(`\\${spelling}`)
    }
  )

  it.each(['\\<b x', '\\<b', 'a \\<ul'])(
    'is kept before %j, which is no tag read whole',
    async (markdown) => {
      expect(textOf(await read(markdown))).toBe(markdown)
    }
  )

  it('is a backslash in code, and in a fence', async () => {
    expect(textOf(await read('`\\<b>`'))).toBe('\\<b>')
    expect(textOf(await read('```\n\\<b>x\\</b>\n```'))).toBe('\\<b>x\\</b>')
  })

  it('is read after an escaped backslash as a tag again', async () => {
    const blocks = await read('\\\\<b>x</b>')
    expect(runsOf(blocks).map((run) => [run.text, run.styles?.bold])).toEqual([
      ['\\', undefined],
      ['x', true]
    ])
  })
})

describe('text that spells a tag the editor handles', () => {
  it.each(HANDLED_SPELLINGS)('writes %s with its angle brackets escaped', async (spelling) => {
    const written = await write([typed(`a ${spelling} b`)])
    expect(written).toBe(`a ${spelling.replace(/</g, '\\<')} b`)
    expect(textOf(await read(written))).toBe(`a ${spelling} b`)
  })

  it('writes a backslash before one as an escaped backslash', async () => {
    const written = await write([typed('\\<b>x</b>')])
    expect(written).toBe('\\\\\\<b>x\\</b>')
    expect(textOf(await read(written))).toBe('\\<b>x</b>')
  })

  it('writes a tag in a bold run inside the bold marks', async () => {
    const written = await write([typed('<i>x</i>', { bold: true })])
    expect(written).toBe('**\\<i>x\\</i>**')
    const runs = runsOf(await read(written))
    expect(runs).toEqual([{ type: 'text', text: '<i>x</i>', styles: { bold: true } }])
  })

  it('writes a tag in a heading, a list item, a quote and a cell', async () => {
    const heading = {
      id: 'h',
      type: 'heading',
      props: { level: 2 },
      content: [{ type: 'text', text: '<b>x</b>', styles: {} }],
      children: []
    } as unknown as Block
    const item = {
      id: 'l',
      type: 'bulletListItem',
      props: {},
      content: [{ type: 'text', text: '<b>x</b>', styles: {} }],
      children: []
    } as unknown as Block
    const quote = {
      id: 'q',
      type: 'quote',
      props: {},
      content: [{ type: 'text', text: '<b>x</b>', styles: {} }],
      children: []
    } as unknown as Block
    const written = await write([heading, item, quote])
    expect(written).toBe('## \\<b>x\\</b>\n\n- \\<b>x\\</b>\n\n> \\<b>x\\</b>')
    expect(textOf(await read(written))).toBe('<b>x</b><b>x</b><b>x</b>')
  })

  it('writes the tags in code as they are', async () => {
    const written = await write([typed('<b>x</b>', { code: true })])
    expect(written).toBe('`<b>x</b>`')
  })

  it('leaves a tag the editor does not handle as it was', async () => {
    const written = await write([typed('a <kbd>Ctrl</kbd> <x a="*b*"> <div>')])
    expect(written).toBe('a <kbd>Ctrl</kbd> <x a="*b*"> <div>')
  })

  it('writes text that spells no whole tag as it is', async () => {
    const written = await write([typed('a <b x, <b and 1 <b> 2 <')])
    expect(written).toBe('a <b x, <b and 1 \\<b> 2 <')
  })
})

describe('the tags a note holds past the nesting cap', () => {
  it('are text, written escaped, and read back as the same text', async () => {
    const markdown = `${'<b>'.repeat(150)}x${'</b>'.repeat(150)}`
    const first = await read(markdown)
    const written = await write(first)
    expect(written.replace(/\\</g, '<').match(/<b>/g)).toHaveLength(50)
    const second = await read(written)
    expect(textOf(second)).toBe(textOf(first))
    expect(await write(second)).toBe(written)
  })
})
