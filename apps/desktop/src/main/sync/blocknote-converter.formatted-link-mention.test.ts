/**
 * A `((mention:…))` token inside a formatted text run stays text (#4652).
 *
 * A `linkMention` node carries no styles, so promoting a token written inside
 * backticks, emphasis or strikethrough drops that formatting from the file the
 * first time the token's paragraph is edited. The seed and the editor's
 * open-time promotion both leave such a token as text; an unformatted token in
 * the same paragraph is still promoted (#4478).
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { normalizeLinkMentions } from '@memry/editor-schema/inline'
import {
  blocksToYFragment,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

const TOKEN = '((mention:https%3A%2F%2Fexample.com%2Fa%5Fb))'
const LEGACY = `((mention:${encodeURIComponent('https://example.com/c_d')}))`

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'the file reached the doc').toBe(true)
  return doc
}

/** What opening the note writes: `promoteLinkMentionsInSharedDoc` in use-editor-sync. */
async function openInEditor(doc: Y.Doc): Promise<void> {
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const normalized = normalizeLinkMentions((await yFragmentToBlocks(fragment)) ?? [])
  if (!normalized.didChange) return
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(normalized.blocks, fragment)
  })
}

function countChips(node: Y.XmlFragment | Y.XmlElement): number {
  return node
    .toArray()
    .reduce(
      (count, child) =>
        child instanceof Y.XmlElement
          ? count + (child.nodeName === 'linkMention' ? 1 : 0) + countChips(child)
          : count,
      0
    )
}

function textRuns(node: Y.XmlFragment | Y.XmlElement): Y.XmlText[] {
  return node
    .toArray()
    .flatMap((child) =>
      child instanceof Y.XmlText ? [child] : child instanceof Y.XmlElement ? textRuns(child) : []
    )
}

/** Appends to the run whose plain text ends with `tail`. */
function appendAfter(doc: Y.Doc, tail: string, suffix: string): void {
  const run = textRuns(doc.getXmlFragment(CRDT_FRAGMENT_NAME)).find((text) =>
    text.toString().endsWith(tail)
  )
  expect(run, `a text run ending in ${tail}`).toBeDefined()
  run!.insert(run!.length, suffix)
}

const FORMATTED = [
  { style: 'inline code', markdown: `A \`${TOKEN}\` b.` },
  { style: 'italics', markdown: `A *${TOKEN}* b.` },
  { style: 'bold', markdown: `A **${TOKEN}** b.` },
  { style: 'strikethrough', markdown: `A ~~${TOKEN}~~ b.` }
]

describe('a link mention token in a formatted run (#4652)', () => {
  it.each(FORMATTED)('keeps a token in $style as text when its paragraph is edited', async (c) => {
    const doc = await seed(c.markdown)

    appendAfter(doc, ' b.', ' Edited.')

    expect(countChips(doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(0)
    expect(await yDocToMarkdown(doc)).toBe(c.markdown.replace(' b.', ' b. Edited.'))
  })

  it('still promotes an unformatted legacy token in the same paragraph', async () => {
    const doc = await seed(`A \`${TOKEN}\` and ${LEGACY} b.`)

    expect(countChips(doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(1)
    appendAfter(doc, ' b.', ' Edited.')
    expect(await yDocToMarkdown(doc)).toBe(
      `A \`${TOKEN}\` and ((mention:https%3A%2F%2Fexample.com%2Fc%5Fd)) b. Edited.`
    )
  })

  it('gets no chip from either device when two open the seeded note before they sync', async () => {
    const a = await seed(FORMATTED.map((c) => c.markdown).join('\n\n'))
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    await openInEditor(a)
    await openInEditor(b)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    expect(countChips(a.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(0)
    expect(countChips(b.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(0)
  })
})
