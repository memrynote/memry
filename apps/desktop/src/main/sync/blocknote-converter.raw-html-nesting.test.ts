/**
 * Handled tags nest in the HTML parse.
 *
 * `<b>`, `<i>`, `<span style>`, `<ul><li>` and the rest of the tags the editor
 * handles reach `tryParseHTMLToBlocks`, whose DOM and ProseMirror recursion
 * cost grows with their depth: 4000 unclosed `<b>` took 5 s, 4000 `<ul><li>`
 * 50 s, and ProseMirror threw `RangeError: Maximum call stack size exceeded`
 * past a few thousand, so the document was never built. A handled tag opened
 * beyond the 100th open handled tag, and its closing tag, are text instead.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { markdownToYFragment, yFragmentToBlocks } from './blocknote-converter'

/** The depth past which a handled tag is text (`MAX_NESTING` of the core's seed). */
const CAP = 100
const LIMIT_MS = 500

interface Run {
  text?: string
  content?: Run[]
}

function textOf(blocks: Block[]): string {
  const out: string[] = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (Array.isArray(block.content)) {
        for (const run of block.content as unknown as Run[]) out.push(run.text ?? '')
      }
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  return out.join('')
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

async function seed(markdown: string): Promise<{ blocks: Block[]; ms: number }> {
  const doc = new Y.Doc()
  const start = performance.now()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  const ms = performance.now() - start
  expect(ok, 'the markdown reached the document').toBe(true)
  return {
    blocks: (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[],
    ms
  }
}

const SPAN = '<span style="color:red">'

/** A tag opened `depth` times with its text in it, with or without the closes. */
const nested = (open: string, close: string, depth: number, closed: boolean): string =>
  open.repeat(depth) + 'x' + (closed ? close.repeat(depth) : '')

describe.each([4000, 8000])('%i nested handled tags', (depth) => {
  describe.each([
    ['<b>', '</b>'],
    ['<i>', '</i>'],
    ['<code>', '</code>'],
    ['<a href=u>', '</a>'],
    [SPAN, '</span>'],
    ['<span style="x:1">', '</span>']
  ])('%s', (open, close) => {
    it.each([true, false])('is read in a bounded time (closed: %s)', async (closed) => {
      const { blocks, ms } = await seed(nested(open, close, depth, closed))
      expect(ms).toBeLessThan(LIMIT_MS)
      // Only the spans no color token took are left for the parse.
      if (open === SPAN && closed) return
      const text = textOf(blocks)
      expect(count(text, open)).toBe(depth - CAP)
      expect(count(text, close)).toBe(closed ? depth - CAP : 0)
    })
  })

  it.each([
    ['a list', '<ul><li>', '</li></ul>'],
    ['a quote', '<blockquote>', '</blockquote>'],
    ['a table', '<table><tr><td>', '</td></tr></table>'],
    ['a figure', '<figure>', '</figure>'],
    ['a toggle', '<details data-memry-toggle>', '</details>'],
    ['a code block', '<pre>', '</pre>']
  ])('%s is read in a bounded time', async (_label, open, close) => {
    for (const closed of [true, false]) {
      const { ms } = await seed(nested(open, close, depth, closed))
      expect(ms).toBeLessThan(LIMIT_MS)
    }
  })

  it('reads a tag that closes on a later line in a bounded time', async () => {
    const { ms } = await seed('<b\n>'.repeat(depth) + 'x')
    expect(ms).toBeLessThan(LIMIT_MS)
  })
})

describe('the depth cap', () => {
  it('keeps every tag of a text that nests no deeper than the cap', async () => {
    const { blocks } = await seed(nested('<b>', '</b>', CAP, true))
    expect(textOf(blocks)).toBe('x')
  })

  it('keeps a tag after tags that closed, however many there were', async () => {
    const { blocks } = await seed('<b>x</b>'.repeat(5 * CAP) + ' <i>y</i>')
    expect(textOf(blocks)).toBe(`${'x'.repeat(5 * CAP)} y`)
  })

  it('counts every kind of handled tag together', async () => {
    const { blocks } = await seed('<b><i><u><s><code>'.repeat(30) + 'x')
    expect(count(textOf(blocks), '<')).toBe(30 * 5 - CAP)
  })
})
