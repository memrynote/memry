/**
 * The handled-tag nesting cap counts what the HTML parse keeps open.
 *
 * The parse recurses once per element it holds open, so a note may not open
 * more than 100 handled tags at once (`raw-html-nesting.test.ts`). The count is
 * what the parse holds, not the number of tags the note spells: HTML closes
 * `<li>`, `<td>`, `<tr>` and their kin by itself, a paragraph ends the marks
 * opened in it, and the active-formatting list keeps three of any identical
 * ones. A note with a hundred unclosed list items, table rows or paragraphs of
 * `<b>` is read as written, and the text a read made is a fixed point of the
 * write that follows.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { markdownToYFragment, yDocToCanonicalMarkdown } from './blocknote-converter'

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** The canonical markdown of the document `markdown` seeds, twice over. */
async function roundTrip(markdown: string): Promise<{ once: string; twice: string }> {
  const write = async (source: string): Promise<string> => {
    const doc = new Y.Doc()
    const ok = await markdownToYFragment(source, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    expect(ok, 'the markdown reached the document').toBe(true)
    return yDocToCanonicalMarkdown(doc)
  }
  const once = await write(markdown)
  return { once, twice: await write(once) }
}

const numbered = (size: number, make: (index: number) => string, join = '\n'): string =>
  Array.from({ length: size }, (_, index) => make(index)).join(join)

describe('a note that leaves handled tags open without nesting', () => {
  it('reads 102 paragraphs of an unclosed <b> as bold, each', async () => {
    const { once, twice } = await roundTrip(numbered(102, (i) => `<b>x${i}`, '\n\n'))
    expect(count(once, '<b>')).toBe(0)
    expect(once).toBe(numbered(102, (i) => `**x${i}**`, '\n\n'))
    expect(twice).toBe(once)
  })

  it('reads 105 list items with no </li> as 105 items', async () => {
    const { once, twice } = await roundTrip(`<ul>\n${numbered(105, (i) => `<li>item${i}`)}\n</ul>`)
    expect(once).toBe(numbered(105, (i) => `- item${i}`))
    expect(twice).toBe(once)
  })

  it('reads 60 table rows of unclosed cells as 60 rows of two cells', async () => {
    const rows = numbered(60, (i) => `<tr><td>a${i}<td>b${i}`)
    const { once, twice } = await roundTrip(`<table>\n${rows}\n</table>`)
    const lines = once.split('\n')
    expect(lines).toHaveLength(2 + 60)
    for (let i = 0; i < 60; i++)
      expect(lines[2 + i]).toMatch(new RegExp(`^\\| a${i} +\\| b${i} +\\|$`))
    expect(twice).toBe(once)
  })

  it('reads unclosed cells and items wherever a paragraph break falls between them', async () => {
    const items = numbered(150, (i) => `<li>item${i}`, '\n\n')
    const { once } = await roundTrip(`<ul>\n\n${items}`)
    expect(count(once, '<li>')).toBe(0)
    expect(count(once, 'item')).toBe(150)
  })
})
