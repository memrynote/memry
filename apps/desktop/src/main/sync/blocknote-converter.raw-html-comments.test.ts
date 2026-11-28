/**
 * An HTML comment inside a tag the editor does not handle is part of the tag.
 *
 * The comments come off a note first, as one token each, and a hidden tag held
 * that token: `<kq a="<!-- c -->">` read back as the text `<kq a="`, an
 * `htmlComment` node, and the text `">`. CommonMark reads the whole thing as one
 * tag, a mark around it was cut in three by the node (`**a <kq a="<!-- c -->">**`
 * was written `**a <kq a="**<!-- c -->**">**`, and the next read kept the stars
 * as text), and the core, which keeps a tag it hides whole, built one text run.
 * A comment on one line is the tag's own characters now. One that crosses lines
 * stays a node, since a line break in a text run is written as a hard break and
 * would change the comment's bytes.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  markdownToYFragment,
  yDocToCanonicalMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

interface Run {
  type: string
  text?: string
  styles?: Record<string, unknown>
  props?: Record<string, unknown>
  content?: Run[]
}

async function read(markdown: string): Promise<Block[]> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
}

async function written(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  return yDocToCanonicalMarkdown(doc)
}

/** Every inline item of every block, a table's cells included. */
function runsOf(blocks: Block[]): Run[] {
  const out: Run[] = []
  const content = (value: unknown): void => {
    if (Array.isArray(value)) out.push(...(value as Run[]))
    else if (typeof value === 'object' && value !== null && 'rows' in value) {
      const rows = (value as { rows: Array<{ cells: unknown[] }> }).rows
      for (const cell of rows.flatMap((row) => row.cells)) {
        const cellContent = Array.isArray(cell) ? cell : (cell as { content?: unknown }).content
        content(cellContent)
      }
    }
  }
  const visit = (list: Block[]): void => {
    for (const block of list) {
      content(block.content)
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  return out
}

const comments = (runs: Run[]): string[] =>
  runs
    .filter((run) => run.type === 'htmlComment')
    .map((run) => (run.props as { source: string }).source)

const CONSTRUCTS = [
  '<kq a="<!-- c -->">',
  '<?x <!-- c -->?>',
  '<![CDATA[ <!-- c --> ]]>',
  '<!x <!-- c --> >',
  '<kq <!-- c --> b="1">'
]

describe('a comment on one line inside a tag the editor does not handle', () => {
  it.each(CONSTRUCTS)('is part of the text of %s', async (construct) => {
    const runs = runsOf(await read(`a ${construct} b`))
    expect(comments(runs)).toEqual([])
    expect(runs.map((run) => run.text).join('')).toBe(`a ${construct} b`)
  })

  it.each([
    ['a heading', '# a <kq a="<!-- c -->">'],
    ['a list item', '- a <kq a="<!-- c -->">'],
    ['a quote', '> a <kq a="<!-- c -->">'],
    ['a table cell', '| a | b |\n| - | - |\n| <kq a="<!-- c -->"> | y |']
  ])('is part of the text in %s', async (_label, markdown) => {
    const runs = runsOf(await read(markdown))
    expect(comments(runs)).toEqual([])
    expect(runs.map((run) => run.text ?? '').join('')).toContain('<kq a="<!-- c -->">')
  })

  it('is written as it was, and read as the same text', async () => {
    for (const construct of CONSTRUCTS) {
      const once = await written(`a ${construct} b`)
      expect(once).toBe(`a ${construct} b`)
      expect(await written(once)).toBe(once)
    }
  })

  it('stays inside the mark that surrounds the tag', async () => {
    const markdown = '**a <kq a="<!-- c -->">** b'
    const once = await written(markdown)
    expect(once).toBe(markdown)
    expect(await written(once)).toBe(once)
    const runs = runsOf(await read(markdown))
    expect(runs.map((run) => [run.text, run.styles?.bold])).toEqual([
      ['a <kq a="<!-- c -->">', true],
      [' b', undefined]
    ])
  })

  it('leaves the comments beside the tag as nodes', async () => {
    const markdown = 'a <!-- d --> <kq a="<!-- c -->"> <!-- e --> b'
    const runs = runsOf(await read(markdown))
    expect(comments(runs)).toEqual(['<!-- d -->', '<!-- e -->'])
    expect(await written(markdown)).toBe(markdown)
  })
})

describe('a comment that crosses lines inside a tag', () => {
  it('stays a node and is written as the bytes it was', async () => {
    const markdown = 'a <kq a="<!-- multi\nline -->"> b'
    const runs = runsOf(await read(markdown))
    expect(comments(runs)).toEqual(['<!-- multi\nline -->'])
    expect(await written(markdown)).toBe(markdown)
  })
})

describe('an Obsidian comment inside a tag', () => {
  it('stays a node, as in the core', async () => {
    const runs = runsOf(await read('a <kq a="%% c %%"> b'))
    expect(comments(runs)).toEqual(['%% c %%'])
  })
})
