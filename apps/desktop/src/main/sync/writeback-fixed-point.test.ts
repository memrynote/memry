/**
 * A note's markdown reaches a fixed point after one write-back.
 *
 * `seed -> write -> seed` builds the document the first seed built, and
 * `write -> seed -> write` writes the bytes the first write wrote, so a note
 * that is opened and saved again and again does not drift. A link or an image
 * whose address the parse cuts at a blank cannot be written back and read
 * again as the same link, and a fence whose language holds a backtick cannot
 * be spelled with backticks, so each of those stays the text it was instead.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { canonicalFragment } from '../../../../../packages/contracts/scripts/fragment-canonical'
import { markdownToYFragment, yDocToCanonicalMarkdown } from './blocknote-converter'

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  return doc
}

const shape = (doc: Y.Doc): string =>
  canonicalFragment(doc).replace(/^(\d+ element blockContainer) id="[^"]*"/gm, '$1')

const CASES: Array<[string, string]> = [
  ['an empty-label link in a link address', '[b]([](u\nv))'],
  ['an empty-label link in an image address', '![a]([](u\nv))'],
  ['an empty-label link in an address, with a title after it', '[b]([](u\nv) "t")'],
  ['an empty-label link in an address, in a line of text', 'a [b]([](u\nv)) c'],
  ['a link address cut inside a parenthesis', '[b](x(y\nz) w)'],
  ['a link address cut inside a parenthesis, by a tab', '[b](x(y\tz\nw) w)'],
  ['an image address cut inside a parenthesis', '![i](x(y z) w)'],
  ['a link address that has a paren and no blank', '[b](x(y)z)'],
  ['a fence language with backticks and a blank before them', '```  ``` x\nc\n```'],
  ['a fence language with a backtick', '```  `` x\nc\n```'],
  ['a tilde fence language with backticks', '~~~  ``` x\nc\n~~~'],
  ['a fence language of one backtick and a pipe', '``` ` |\nc\n```']
]

describe('write-back reaches a fixed point', () => {
  it.each(CASES)('%s', async (_name, markdown) => {
    const first = await seed(markdown)
    const written = await yDocToCanonicalMarkdown(first)
    expect(written, 'the doc writes back').not.toBeNull()
    const second = await seed(written ?? '')
    expect(shape(second), `seed(write(seed(m))) for ${JSON.stringify(written)}`).toBe(shape(first))
    expect(await yDocToCanonicalMarkdown(second)).toBe(written)
  })
})
