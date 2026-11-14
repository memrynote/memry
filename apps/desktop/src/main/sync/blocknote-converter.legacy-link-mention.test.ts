/**
 * A `((mention:…))` token an older build wrote with `_ * ! ~ '` raw (#4478).
 *
 * The seed promotes it to a `linkMention` node like any other token, so every
 * device builds the same node from the file and no device promotes it on its
 * own when the note opens. Two devices doing that before they synced merged
 * into two chips per mention (#3871).
 *
 * The node cannot spell the legacy bytes back (`a_b` and `a%5Fb` decode to the
 * same URL), so the source record (#1915) is what keeps them: identical while
 * the token's paragraph is untouched, re-encoded once that paragraph is edited
 * or when the doc has no record. The corpus in `@memry/editor-schema/conformance`
 * pins the rows without an edit: identical with the record, re-encoded without.
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

// `encodeURIComponent` alone: the token builds before #1844 wrote.
const legacyToken = (url: string): string => `((mention:${encodeURIComponent(url)}))`

const LEGACY = legacyToken('https://example.com/a_b')
const MARKDOWN = `See ${LEGACY} here.\n\nOther paragraph.`

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'the file reached the doc').toBe(true)
  return doc
}

/**
 * What opening the note in the editor writes: the renderer runs
 * `normalizeLinkMentions` over the document and replaces the blocks when it
 * promoted anything (`promoteLinkMentionsInSharedDoc`).
 */
async function openInEditor(doc: Y.Doc): Promise<void> {
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const blocks = await yFragmentToBlocks(fragment)
  const normalized = normalizeLinkMentions(blocks ?? [])
  if (!normalized.didChange) return
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(normalized.blocks, fragment)
  })
}

function countNodes(node: Y.XmlFragment | Y.XmlElement, name: string): number {
  let count = 0
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === name) count++
    count += countNodes(child, name)
  }
  return count
}

/** The paragraph text runs in document order, chips' neighbours included. */
function textRuns(node: Y.XmlFragment | Y.XmlElement): Y.XmlText[] {
  return node
    .toArray()
    .flatMap((child) =>
      child instanceof Y.XmlText ? [child] : child instanceof Y.XmlElement ? textRuns(child) : []
    )
}

function appendTo(doc: Y.Doc, runText: string, suffix: string): void {
  const run = textRuns(doc.getXmlFragment(CRDT_FRAGMENT_NAME)).find(
    (text) => text.toString() === runText
  )
  expect(run, `a text run reading ${runText}`).toBeDefined()
  run!.insert(run!.length, suffix)
}

describe('a legacy link mention token (#4478)', () => {
  it('merges into one chip when two devices open the seeded note before they sync', async () => {
    // #given the seeded doc on two devices. Two independent seeds of one file
    // are a different race (§12.1.0): their merge holds the whole body twice.
    const a = await seed(MARKDOWN)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    // #when each opens the note, then they exchange updates
    await openInEditor(a)
    await openInEditor(b)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    // #then one chip per mention on both
    expect(countNodes(a.getXmlFragment(CRDT_FRAGMENT_NAME), 'linkMention')).toBe(1)
    expect(countNodes(b.getXmlFragment(CRDT_FRAGMENT_NAME), 'linkMention')).toBe(1)
  })

  it('seeds the token as a linkMention node', async () => {
    const doc = await seed(MARKDOWN)

    const blocks = await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))

    expect(blocks?.[0]?.content).toEqual([
      { type: 'text', text: 'See ', styles: {} },
      {
        type: 'linkMention',
        props: {
          url: 'https://example.com/a_b',
          domain: 'example.com',
          title: '',
          favicon: '',
          siteName: ''
        }
      },
      { type: 'text', text: ' here.', styles: {} }
    ])
  })

  it('keeps its bytes when another block is edited', async () => {
    // #given
    const doc = await seed(MARKDOWN)

    // #when
    appendTo(doc, 'Other paragraph.', ' Edited.')

    // #then
    expect(await yDocToMarkdown(doc)).toBe(`See ${LEGACY} here.\n\nOther paragraph. Edited.`)
  })

  it('re-encodes the token when its own paragraph is edited', async () => {
    // #given
    const doc = await seed(MARKDOWN)

    // #when
    appendTo(doc, ' here.', ' Edited.')

    // #then
    expect(await yDocToMarkdown(doc)).toBe(
      'See ((mention:https%3A%2F%2Fexample.com%2Fa%5Fb)) here. Edited.\n\nOther paragraph.'
    )
  })
})
