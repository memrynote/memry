/**
 * A `((date:…))` token is promoted to a `dateMention` node at seed.
 *
 * Left as text, every device's editor promoted it on open, so a client
 * without that editor showed the base64 payload, and two devices opening the
 * seeded note before they synced merged into two pills per date (#3871). A
 * token in a styled run or a code block stays text (#4652): the node carries
 * no styles, so promoting it would drop the delimiters on write-back.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { normalizeDateMentions } from '@memry/editor-schema/inline'
import { serializeDateMentionToken, type DateMentionData } from '@memry/shared/date-mention'
import {
  blocksToYFragment,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

const DATA: DateMentionData = {
  anchorId: 'dm_1',
  dateISO: '2026-08-14T09:00:00.000Z',
  hasTime: true,
  dateFormat: 'relative',
  remind: '1h',
  timeFormat: 'system'
}
const TOKEN = serializeDateMentionToken(DATA)

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'the file reached the doc').toBe(true)
  return doc
}

/** What opening the note writes: `promoteDateMentionsInSharedDoc` in use-editor-sync. */
async function openInEditor(doc: Y.Doc): Promise<void> {
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const normalized = normalizeDateMentions((await yFragmentToBlocks(fragment)) ?? [])
  if (!normalized.didChange) return
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(normalized.blocks, fragment)
  })
}

function countPills(node: Y.XmlFragment | Y.XmlElement): number {
  return node
    .toArray()
    .reduce(
      (count, child) =>
        child instanceof Y.XmlElement
          ? count + (child.nodeName === 'dateMention' ? 1 : 0) + countPills(child)
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

describe('a date mention token at seed', () => {
  it('seeds the token as a dateMention node', async () => {
    const doc = await seed(`Due ${TOKEN} here.`)

    const blocks = await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))

    expect(blocks?.[0]?.content).toEqual([
      { type: 'text', text: 'Due ', styles: {} },
      { type: 'dateMention', props: DATA },
      { type: 'text', text: ' here.', styles: {} }
    ])
  })

  it('writes a well-formed token back byte-identical after its paragraph is edited', async () => {
    const doc = await seed(`Due ${TOKEN} here.\n\nOther paragraph.`)

    appendAfter(doc, ' here.', ' Edited.')

    expect(await yDocToMarkdown(doc)).toBe(`Due ${TOKEN} here. Edited.\n\nOther paragraph.`)
  })

  it('keeps a base64url token until its own paragraph is edited, then writes the closed alphabet', async () => {
    // `?` drives base64 onto the symbols the pre-#1845 writer spelled `-`/`_`.
    const legacyData = { ...DATA, anchorId: 'dm_0?x' }
    const legacy = `((date:${btoa(JSON.stringify(legacyData)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}))`
    const doc = await seed(`Due ${legacy} here.\n\nOther paragraph.`)

    appendAfter(doc, 'Other paragraph.', ' Edited.')
    expect(await yDocToMarkdown(doc)).toBe(`Due ${legacy} here.\n\nOther paragraph. Edited.`)

    appendAfter(doc, ' here.', ' Edited.')
    expect(await yDocToMarkdown(doc)).toBe(
      `Due ${serializeDateMentionToken(legacyData)} here. Edited.\n\nOther paragraph. Edited.`
    )
  })

  it.each([
    { style: 'bold', markdown: `A **${TOKEN}** b.` },
    { style: 'inline code', markdown: `A \`${TOKEN}\` b.` }
  ])('keeps a token in $style as text when its paragraph is edited', async (c) => {
    const doc = await seed(c.markdown)

    appendAfter(doc, ' b.', ' Edited.')

    expect(countPills(doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(0)
    expect(await yDocToMarkdown(doc)).toBe(c.markdown.replace(' b.', ' b. Edited.'))
  })

  it('keeps a token in a fenced code block as text', async () => {
    const markdown = `\`\`\`\n${TOKEN}\n\`\`\``
    const doc = await seed(markdown)

    expect(countPills(doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(0)
    expect(await yDocToMarkdown(doc)).toBe(markdown)
  })

  it('merges into one pill when two devices open the seeded note before they sync', async () => {
    const a = await seed(`Due ${TOKEN} here.`)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    await openInEditor(a)
    await openInEditor(b)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    expect(countPills(a.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(1)
    expect(countPills(b.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(1)
  })
})
