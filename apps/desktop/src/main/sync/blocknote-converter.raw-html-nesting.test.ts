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

/**
 * CPU time the process has used, in ms. The bounds below are on the work a read
 * does; wall time also counts the seconds a loaded machine makes it wait.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** The depth past which a handled tag is text (`MAX_NESTING` of the core's seed). */
const CAP = 100
/**
 * How much longer a nested read may take than a flat read of the same tags.
 *
 * The bound is relative because CI runs these under coverage, which makes every
 * read several times slower, and a loaded machine stretches CPU time too. Before
 * the cap the nested read cost 50x its flat twin (4000 `<b>` took 5 s, 4000
 * `<ul><li>` 50 s) or overflowed the stack; with it the two read alike.
 */
const RATIO = 4
/** Absolute slack, so a flat read of a few ms leaves room for timer noise. */
const SLACK_MS = 100

/** The same tags at depth one: each opened, given its text and closed in turn. */
const flat = (open: string, close: string, depth: number): string =>
  (open + 'x' + close).repeat(depth)

async function expectBoundedAgainstFlat(
  nestedMs: number,
  open: string,
  close: string,
  depth: number
) {
  const { ms: flatMs } = await seed(flat(open, close, depth))
  expect(nestedMs).toBeLessThan(RATIO * flatMs + SLACK_MS)
}

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
    const start = cpuMs()
    const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    ms = Math.min(ms, cpuMs() - start)
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
      await expectBoundedAgainstFlat(ms, open, close, depth)
      // Only the spans no color token took are left for the parse.
      if (open === SPAN && closed) return
      const text = textOf(blocks)
      // A second `<a>` closes the first, so they never nest and none is text.
      const nests = open !== '<a href=u>'
      expect(count(text, open)).toBe(nests ? depth - CAP : 0)
      expect(count(text, close)).toBe(nests && closed ? depth - CAP : 0)
    })
  })
})

/**
 * A block tag builds a block per level, so the shapes run at one depth, 20 times
 * the cap: deep enough that the uncapped parse cost a minute or overflowed, and
 * a list past the cap is still a list of hundreds of items BlockNote builds.
 */
const BLOCK_DEPTH = 2000

describe(`${BLOCK_DEPTH} nested block tags`, () => {
  it.each([
    ['a list', '<ul><li>', '</li></ul>'],
    ['a quote', '<blockquote>', '</blockquote>'],
    ['a table', '<table><tr><td>', '</td></tr></table>'],
    ['a figure', '<figure>', '</figure>'],
    ['a toggle', '<details data-memry-toggle>', '</details>'],
    ['a code block', '<pre>', '</pre>']
  ])(
    '%s is read in a bounded time',
    async (_label, open, close) => {
      for (const closed of [true, false]) {
        const { ms } = await seed(nested(open, close, BLOCK_DEPTH, closed))
        await expectBoundedAgainstFlat(ms, open, close, BLOCK_DEPTH)
      }
    },
    // Each read runs twice, beside its flat twin, under coverage on CI.
    300_000
  )
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

describe('marks a list item or a table cell leaves open', () => {
  it.each([
    ['list items', Array.from({ length: 105 }, (_, i) => `- <i>item${i}`).join('\n')],
    [
      'table rows',
      `| a |\n| - |\n${Array.from({ length: 105 }, (_, i) => `| <b>c${i} |`).join('\n')}`
    ]
  ])('are marks in all of %s, not text', async (_label, markdown) => {
    const { blocks } = await seed(markdown)
    // The HTML parse closes the mark at each `</li>` and `</td>`, so no tag is past the cap.
    expect(count(textOf(blocks), '<')).toBe(0)
  })
})
