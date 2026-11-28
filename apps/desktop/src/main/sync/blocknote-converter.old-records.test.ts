/**
 * A note whose source record an earlier build wrote is read with that build's
 * rules.
 *
 * The write-back proves the author's spelling against the document by reading
 * the source again and comparing what the read writes with what the document
 * writes. A record from before raw HTML stayed text sits beside a document
 * that dropped `<kbd>`, `<sup>` and every other tag the editor has no node for,
 * so the source has to be read that way too. Read as text, the same source
 * writes `Press <kbd>Ctrl</kbd>`, the proof fails, and the whole note comes
 * back in house style: `Press Ctrl+C`, `mc2`, the image alone.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { MARKDOWN_SOURCE_MAP } from '@memry/shared/markdown-source'
import {
  blocksToYFragment,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'
import { OLD_RECORD_NOTES } from './blocknote-converter.old-records.fixtures'

function load(update: string): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(update, 'base64')))
  return doc
}

/** The document with one paragraph typed after its last block, record kept. */
async function withTypedParagraph(doc: Y.Doc, text: string): Promise<Y.Doc> {
  const blocks = (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
  const typed = {
    id: 'typed',
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text, styles: {} }],
    children: []
  } as unknown as Block
  const edited = new Y.Doc()
  expect(blocksToYFragment([...blocks, typed], edited.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(
    true
  )
  const record: unknown = doc.getMap(MARKDOWN_SOURCE_MAP).get('record')
  edited.getMap(MARKDOWN_SOURCE_MAP).set('record', JSON.parse(JSON.stringify(record)))
  return edited
}

describe('a note an earlier build seeded and recorded', () => {
  it.each(OLD_RECORD_NOTES)('writes $name back as the file had it', async ({ source, update }) => {
    expect(await yDocToMarkdown(load(update))).toBe(source)
  })

  it.each(OLD_RECORD_NOTES.filter(({ name }) => name !== 'escaped tag'))(
    'keeps the bytes of $name when a paragraph is typed after it',
    async ({ source, update }) => {
      const edited = await withTypedParagraph(load(update), 'edited tail')

      expect(await yDocToMarkdown(edited)).toBe(`${source}\n\nedited tail`)
    }
  )

  it('records a note seeded now so that the next read keeps raw HTML as text', async () => {
    const source = '* Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.\n\nStable middle line.'
    const doc = new Y.Doc()
    expect(await markdownToYFragment(source, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)

    expect(doc.getMap(MARKDOWN_SOURCE_MAP).get('record')).toMatchObject({
      source,
      literalHtml: true
    })
    expect(await yDocToMarkdown(doc)).toBe(source)
    const edited = await withTypedParagraph(doc, 'edited tail')
    expect(await yDocToMarkdown(edited)).toBe(`${source}\n\nedited tail`)
  })
})
