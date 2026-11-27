/**
 * Text that spells a placeholder the markdown masks use must stay text.
 *
 * The read path hides constructs from BlockNote's parser behind placeholders
 * (`MEMRYHBK0;`, `MEMRYCSP0X`, …) and puts them back after. A note that
 * already holds the spelling (a note ABOUT this app, or a paste from one) must
 * come out as the same document it would be with any other word there, not
 * have the author's text eaten or swapped for a masked construct.
 *
 * The property: seeding `MEMRY` as text is seeding `MEMRX` as text. The
 * second spelling is no placeholder of any mask, so its document is the
 * reference, and the first must be that document with the word swapped back.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { canonicalFragment } from '../../../../../packages/contracts/scripts/fragment-canonical'
import { markdownToYFragment } from './blocknote-converter'

async function seeded(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  return canonicalFragment(doc).replace(/^(\d+ element blockContainer) id="[^"]*"/gm, '$1')
}

const CASES: Array<[string, string]> = [
  [
    'table cell code spans (MEMRYCSP)',
    '| `x|MEMRYCSP0X` | `MEMRYCSP0X` |\n| --- | --- |\n| `a b` | c |'
  ],
  ['a hard break (MEMRYHBK)', 'a  \nMEMRYHBK0;\nb'],
  ['a hard break before a token on its line', 'a  \nMEMRYHBK0;b\nc'],
  ['an inline token (MEMRYTKN)', 'MEMRYTKN0X and ((mention:abc))'],
  [
    'a table row wider than its header, after text spelling its probe (MEMRYTBL)',
    'MEMRYTBL0X\n\n| a |\n| --- |\n| b | MEMRYTBL1X | c |'
  ],
  ['a details markup line (MEMRYDLT)', '<details data-x>\nMEMRYDLT;summary>t\n'],
  [
    'a colour span (MEMRYICO)',
    '<span style="color:red">x</span> MEMRYICO0:y:MEMRYICC; MEMRYICO1:z'
  ],
  ['a link card marker (MEMRYLINKCARD)', 'MEMRYLINKCARD link-card:{"a":1} -->\n[[a]]'],
  [
    'the per-process placeholders, as a reader sees them',
    'MEMRYEMO0; MEMRYEMC0; MEMRYEMK0; MEMRYEMU0; MEMRYLNK0X MEMRYCMT0aX MEMRYEMB'
  ]
]

describe('markdown placeholders typed as text', () => {
  it.each(CASES)('%s', async (_name, markdown) => {
    const reference = await seeded(markdown.replaceAll('MEMRY', 'MEMRX'))
    expect(await seeded(markdown)).toBe(reference.replaceAll('MEMRX', 'MEMRY'))
  })
})
