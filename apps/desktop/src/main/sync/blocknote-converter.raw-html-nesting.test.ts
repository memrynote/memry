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
/** A block tag also builds blocks, which take longer than a mark. */
const BLOCK_LIMIT_MS = 1000

interface Run {
  text?: string
  content?: Run[]
}

function textOf(blocks: Block[]): string {
  const out: string[] = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (Array.isArray(block.content)) {
        for (const run of block.content as unknown as Run[]) {
          out.push(run.text ?? '')
          // A link holds its text one level down.
          for (const inner of run.content ?? []) out.push(inner.text ?? '')
        }
      }
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  return out.join('')
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

/**
 * The blocks `markdown` seeds, and how long the faster of two seeds took: load
 * on the machine only ever adds to a run.
 */
async function seed(markdown: string): Promise<{ blocks: Block[]; ms: number }> {
  let ms = Infinity
  let doc = new Y.Doc()
  for (let run = 0; run < 2; run++) {
    doc = new Y.Doc()
    const start = performance.now()
    const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    ms = Math.min(ms, performance.now() - start)
    expect(ok, 'the markdown reached the document').toBe(true)
  }
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
      expect(ms).toBeLessThan(BLOCK_LIMIT_MS)
    }
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

  it('counts a handled tag that closes on a later line', async () => {
    const { blocks } = await seed('<b\n y="1">'.repeat(150) + 'x')
    expect(count(textOf(blocks), '<b')).toBe(50)
  })

  it('counts every kind of handled tag together', async () => {
    const { blocks } = await seed('<b><i><u><s><code>'.repeat(30) + 'x')
    expect(count(textOf(blocks), '<')).toBe(30 * 5 - CAP)
  })
})
