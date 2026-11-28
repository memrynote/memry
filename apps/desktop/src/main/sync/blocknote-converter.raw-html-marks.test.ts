/**
 * A mark never cuts through a tag spelled in text.
 *
 * The reader hides a whole tag (`<x a="*">`) and keeps the characters in it,
 * so a mark whose delimiters the writer put inside one added characters to the
 * tag: bold `*` between `<x a="` and `">` was written `<x a="**\***">`, and
 * `a **b <x a="x**"> c` gained backslashes on the next write. The writer decides
 * what is a tag on the text of runs side by side, not on each run alone, and a
 * tag that a mark boundary cuts through loses the marks inside it: the
 * characters stay, written as they are, and the note settles.
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

const text = (value: string, styles: Record<string, unknown> = {}): Run => ({
  type: 'text',
  text: value,
  styles
})

async function write(runs: Run[]): Promise<string> {
  const doc = new Y.Doc()
  const block = { id: 'p', type: 'paragraph', props: {}, content: runs, children: [] }
  expect(
    blocksToYFragment([block] as unknown as Block[], doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  ).toBe(true)
  return (await yDocToCanonicalMarkdown(doc)) ?? ''
}

async function read(markdown: string): Promise<{ runs: Run[]; written: string }> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  const blocks = (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
  return {
    runs: blocks.flatMap((block) => (Array.isArray(block.content) ? (block.content as Run[]) : [])),
    written: (await yDocToCanonicalMarkdown(doc)) ?? ''
  }
}

const plain = (runs: Run[]): string => runs.map((run) => run.text ?? '').join('')

describe('a mark boundary inside a tag the editor does not handle', () => {
  it.each([
    ['bold', { bold: true }, '*', '<kq a="*">'],
    ['italic', { italic: true }, 'x', '<kq a="x">'],
    ['strike', { strike: true }, 'x', '<kq a="x">'],
    ['code', { code: true }, 'x', '<kq a="x">']
  ])(
    'takes the %s mark off the characters inside the tag',
    async (_name, styles, inner, written) => {
      const runs = [text('<kq a="'), text(inner, styles), text('">')]
      const markdown = await write(runs)
      expect(markdown).toBe(written)
      const back = await read(markdown)
      expect(plain(back.runs)).toBe(plain(runs))
      expect(back.written).toBe(markdown)
    }
  )

  it('keeps the mark on the characters outside the tag', async () => {
    const markdown = await write([text('a '), text('b <kq a="x', { bold: true }), text('"> c')])
    expect(markdown).toBe('a **b** <kq a="x"> c')
    const back = await read(markdown)
    expect(back.runs.map((run) => [run.text, run.styles?.bold])).toEqual([
      ['a ', undefined],
      ['b', true],
      [' <kq a="x"> c', undefined]
    ])
    expect(back.written).toBe(markdown)
  })

  it('leaves a tag a mark covers whole, or a mark that holds a whole tag, as it is', async () => {
    expect(await write([text('<kq a="*">', { bold: true })])).toBe('**<kq a="*">**')
    expect(await write([text('x <kq a="*"> y', { bold: true })])).toBe('**x <kq a="*"> y**')
  })

  it('reads the text of two tags beside a mark as it was written', async () => {
    const runs = [
      text('<kq a="'),
      text('*', { bold: true }),
      text('"> <x b="'),
      text('_', { italic: true }),
      text('">')
    ]
    const markdown = await write(runs)
    expect(markdown).toBe('<kq a="*"> <x b="_">')
    expect(plain((await read(markdown)).runs)).toBe(plain(runs))
  })
})

describe('a mark boundary inside a tag the editor handles, spelled in text', () => {
  it('writes the tags escaped and the text between them with its mark', async () => {
    const runs = [text('<b'), text('>x</b', { bold: true }), text('>')]
    const markdown = await write(runs)
    expect(markdown).toBe('\\<b>**x**\\</b>')
    const back = await read(markdown)
    expect(back.runs.map((run) => [run.text, run.styles?.bold])).toEqual([
      ['<b>', undefined],
      ['x', true],
      ['</b>', undefined]
    ])
    expect(back.written).toBe(markdown)
  })
})

describe('a <br> inside a tag the editor does not handle', () => {
  it.each(['a <kq a="<br>x"> b', '<kq a="<br>>">', 'a <?x <br> y?> b', '**a <kq a="<br>x"> b**'])(
    'is the characters of the tag in %j, with no token among them',
    async (markdown) => {
      const { runs, written } = await read(markdown)
      const found = runs.map((run) => run.text ?? '').join('')
      expect(found).not.toMatch(/MEMRYHBK/)
      expect(found).toContain('<br>')
      expect(written).toBe(markdown)
    }
  )

  it('is the characters of the tag in a table cell', async () => {
    const { written } = await read('| a | b |\n| - | - |\n| <kq a="<br>x"> | y |')
    expect(written).not.toMatch(/MEMRYHBK/)
    expect(written).toContain('<kq a="<br>x">')
  })
})
