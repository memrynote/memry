/**
 * A `<details>` markup line that holds a tag the editor handles reaches a fixed
 * point.
 *
 * The reader hides every `<` of such a line, so a foreign
 * `<summary><b>x</b></summary>` is the text it was written with. The writer
 * spells a handled tag in text with its `<` escaped (`\<b>x\</b>`), and the
 * reader of the escaped spelling kept the backslashes as text, so each save
 * wrote three more of them: `\<b>`, `\\\<b>`, `\\\\\<b>`. Both spellings read
 * as the same characters now.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { canonicalFragment } from '../../../../../packages/contracts/scripts/fragment-canonical'
import {
  markdownToYFragment,
  yDocToCanonicalMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return doc
}

/** The document, with the random ids of its blocks off. */
const shape = (doc: Y.Doc): string =>
  canonicalFragment(doc).replace(/^(\d+ element blockContainer) id="[^"]*"/gm, '$1')

async function write(doc: Y.Doc): Promise<string> {
  const markdown = await yDocToCanonicalMarkdown(doc)
  expect(markdown).not.toBeNull()
  return markdown ?? ''
}

/** The characters of every text run of the document, in order. */
async function textOf(doc: Y.Doc): Promise<string> {
  const blocks = (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) ?? []
  const runs: string[] = []
  const visit = (list: unknown[]): void => {
    for (const block of list as Array<{ content?: unknown; children?: unknown[] }>) {
      if (Array.isArray(block.content)) {
        for (const run of block.content as Array<{ text?: string }>) runs.push(run.text ?? '')
      }
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  return runs.join('')
}

const FOREIGN = (summary: string): string =>
  `<details>\n<summary>${summary}</summary>\ny\n</details>`

const CASES: Array<[string, string]> = [
  ['a bold tag in a foreign summary', FOREIGN('<b>x</b>')],
  ['an italic tag after text', FOREIGN('Use <i>this</i>')],
  ['a break between words', FOREIGN('a<br>b')],
  ['a link', FOREIGN('<a href="https://e.com">x</a>')],
  ['two tags', FOREIGN('<b>x</b> and <code>y</code>')],
  ['a summary line in a paragraph', '<summary><b>x</b></summary>'],
  ['a summary line in a quote', '> <summary><b>x</b></summary>'],
  ['a summary line in a heading', '# <summary><b>x</b></summary>'],
  ['a summary line after a line of text', 'a\n<summary><b>x</b></summary>'],
  ['a summary line with a tail', '<summary><b>x</b></summary><br>more <b>y</b>'],
  ['a backslash before a bold tag', FOREIGN('\\\\<b>x</b>')],
  ['an escaped tag the author wrote', FOREIGN('\\<b>x\\</b>')]
]

describe('a <details> markup line holding a handled tag', () => {
  it.each(CASES)('settles after one save: %s', async (_name, markdown) => {
    const first = await write(await seed(markdown))
    const second = await write(await seed(first))
    const third = await write(await seed(second))
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it.each(CASES)('keeps the characters the reader sees: %s', async (_name, markdown) => {
    const doc = await seed(markdown)
    const written = await seed(await write(doc))
    expect(shape(written)).toBe(shape(doc))
  })

  it('reads a bare tag and its escaped spelling as the same text', async () => {
    const bare = await seed(FOREIGN('Use <i>this</i>'))
    const escaped = await seed(FOREIGN('Use \\<i>this\\</i>'))
    expect(await textOf(escaped)).toBe(await textOf(bare))
    expect(await textOf(bare)).toContain('<summary>Use <i>this</i></summary>')
    expect(shape(escaped)).toBe(shape(bare))
  })

  it('keeps a backslash before a tag the editor does not handle', async () => {
    const markdown = FOREIGN('C:\\<path>')
    expect(await write(await seed(markdown))).toBe(markdown)
  })
})
