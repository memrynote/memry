/**
 * A mask's placeholder never reaches the document.
 *
 * The read path hides constructs from BlockNote's parser behind per-process
 * placeholders and swaps them back once the blocks exist. A placeholder that
 * survives is written into the vault as text, and no other process can decode
 * it. Each trigger below sits in each place a block carries a string (a link
 * address, an image alt and address, a code fence's language, a table cell, a
 * math block, a summary), and the document must hold the author's bytes, never
 * a placeholder. `MEMRY` does not occur in any input, so any in the output is a
 * leak.
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

const TRIGGERS: Array<[string, string]> = [
  ['a hard break', 'x  \ny'],
  ['a backslash break', 'x\\\ny'],
  ['a mention token', '((mention:a_b_c))'],
  ['a date token', '((date:2020-01-01))'],
  ['a spaced address', '[a](u "t")'],
  ['an angled address', '[a](<u v>)'],
  ['an address across a hard break', '[a](u  \nv)'],
  ['a comment', '%% c %%'],
  ['an html comment', '<!-- c -->'],
  ['a comment across lines', '%% c\nd %%'],
  ['an empty-label link', '[](u)'],
  ['an empty-label link across lines', '[](u\nv)'],
  ['a details tag', '<details>']
]

const PLACES: Array<[string, string]> = [
  ['a link address', '[a](u{T})'],
  ['an angled link address', '[a](<u{T}>)'],
  ['a link title', '[a](u "{T}")'],
  ['an image alt', '![a{T}](u)'],
  ['an image address', '![a](u{T})'],
  ['an image title', '![a](u "{T}")'],
  ['a code fence language', '```js{T}\nx\n```'],
  ['a tilde fence language', '~~~{T}\nx\n~~~'],
  ['a fence language in a list item', '- a\n    ```{T}\n    x\n    ```'],
  ['a table cell', '| a | b |\n| - | - |\n| {T} | c |'],
  ['a table cell link address', '| a |\n| - |\n| [a](u{T}) |'],
  ['a table cell image alt', '| a |\n| - |\n| ![x{T}](u) |'],
  ['a heading', '# {T}'],
  ['a quote', '> {T}'],
  ['a list item', '- {T}'],
  ['a callout title', '> [!note] {T}\n> x'],
  ['a toggle summary', '<details>\n<summary>{T}</summary>\n\nx\n\n</details>'],
  ['a math block', '$$\n{T}\n$$'],
  ['link text', '[{T}](u)']
]

const CASES = PLACES.flatMap(([place, template]) =>
  TRIGGERS.map(([trigger, text]): [string, string] => [
    `${trigger} in ${place}`,
    template.replace('{T}', text)
  ])
)

describe('markdown masks leave no placeholder in the document', () => {
  it.each(CASES)('%s', async (_name, markdown) => {
    const canonical = await seeded(markdown)
    expect(canonical.match(/MEMRY\w*/)?.[0]).toBeUndefined()
  })

  it('an address across a hard break is the address BlockNote reads with no mask', async () => {
    expect(await seeded('[a](u  \nv)')).toContain('link={"href":"u"}')
  })
})
