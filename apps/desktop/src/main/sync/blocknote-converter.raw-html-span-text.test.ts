/**
 * Text that spells a span, or a toggle's `<details>`, is a fixed point of the write.
 *
 * A `<span>` the note leaves open takes the `</span>` the writer ends a coloured
 * or underlined run with, so `<u>a <span> b</u>` grew one more `</span>` on every
 * save, and `<span style="color:red">a<span>b` the same. Typed text that spells
 * `<span style="color:red">x</span>` or `<details data-memry-toggle>` lost its
 * tag characters as soon as it was read back. The writer now escapes the `<` of
 * such text (`\<span>`), as it does for the other tags the editor handles, and
 * the reader reads the escape as the character.
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

async function write(blocks: Block[]): Promise<string> {
  const doc = new Y.Doc()
  expect(blocksToYFragment(blocks, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return (await yDocToCanonicalMarkdown(doc)) ?? ''
}

const typed = (text: string): Block =>
  ({
    id: 'p',
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text, styles: {} }],
    children: []
  }) as unknown as Block

const runsOf = (blocks: Block[]): Run[] =>
  blocks.flatMap((block) => (Array.isArray(block.content) ? (block.content as Run[]) : []))

/** The note written three times over, each write read back first. */
async function saves(markdown: string): Promise<string[]> {
  const out: string[] = []
  let current = markdown
  for (let save = 0; save < 3; save++) {
    current = await write(await read(current))
    out.push(current)
  }
  return out
}

describe('a span the note leaves open', () => {
  it.each([
    '<u>a <span> b</u>',
    '<span style="color:red">a<span>b',
    '<u>a <span class="x"> b</u>',
    '<span style="color:red">a <span style="color:blue">b',
    '<u>a </span> b</u>',
    '<span style="color:red">a </span> b'
  ])('reaches a fixed point in %s', async (markdown) => {
    const [first, second, third] = await saves(markdown)

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('keeps the span as the text it is, inside the coloured run', async () => {
    const [first] = await saves('<u>a <span> b</u>')

    expect(first).toBe('<span style="text-decoration:underline">a \\<span> b</span>')
    const runs = runsOf(await read(first))
    expect(runs.map((run) => [run.text, run.styles?.underline])).toEqual([['a <span> b', true]])
  })
})

describe('typed text that spells a span or a toggle', () => {
  it.each([
    ['a coloured span', '<span style="color:red">x</span>', '\\<span style="color:red">x\\</span>'],
    ['a plain span', 'a <span> b', 'a \\<span> b'],
    ['a closing span', 'a </span> b', 'a \\</span> b'],
    ['a toggle', '<details data-memry-toggle> x', '\\<details data-memry-toggle> x'],
    [
      'an open toggle',
      'a <details data-memry-toggle open> x',
      'a \\<details data-memry-toggle open> x'
    ]
  ])('is written with its angle bracket escaped, %s', async (_name, text, written) => {
    expect(await write([typed(text)])).toBe(written)
  })

  it.each([
    '<span style="color:red">x</span>',
    'a <span> b',
    'a </span> b',
    '<details data-memry-toggle> x',
    'a <details data-memry-toggle open> x'
  ])('comes back as the same text: %s', async (text) => {
    const runs = runsOf(await read(await write([typed(text)])))

    expect(runs.map((run) => [run.text, run.styles?.textColor])).toEqual([[text, undefined]])
  })

  it('does not end a colour, as a closing span typed inside one did', async () => {
    const blocks = [
      {
        id: 'p',
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'a </span> b', styles: { textColor: 'red' } },
          { type: 'text', text: ' c', styles: {} }
        ],
        children: []
      } as unknown as Block
    ]
    const runs = runsOf(await read(await write(blocks)))

    expect(runs.map((run) => [run.text, run.styles?.textColor])).toEqual([
      ['a </span> b', 'red'],
      [' c', undefined]
    ])
  })
})
