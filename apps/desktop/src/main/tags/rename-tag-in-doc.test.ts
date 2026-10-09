import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { INLINE_TAG_RENAME_CASES } from '../../../../../packages/shared/src/inline-tag-rename-cases'

vi.mock('../sync/crdt-provider', () => ({ ORIGIN_LOCAL: 'local' }))

import { renameTagsInDoc } from './rename-tag-in-doc'

function docOf(pieces: (typeof INLINE_TAG_RENAME_CASES)[number]['pieces']): {
  doc: Y.Doc
  text: Y.XmlText
} {
  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  doc.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [paragraph])
  paragraph.insert(0, [text])
  let at = 0
  for (const piece of pieces) {
    const marks = { ...(piece.code ? { code: true } : {}), ...(piece.bold ? { bold: true } : {}) }
    text.insert(at, piece.text, marks)
    at += piece.text.length
  }
  return { doc, text }
}

describe('renameTagsInDoc shared cases', () => {
  for (const c of INLINE_TAG_RENAME_CASES) {
    it(c.name, () => {
      const { doc, text } = docOf(c.pieces)
      renameTagsInDoc(doc, c.renames)
      expect(text.toString().replace(/<\/?[a-z]+>/g, '')).toBe(c.expected)
    })
  }

  it('keeps the formatting of a renamed tag', () => {
    const { doc, text } = docOf([{ text: 'see ' }, { text: '#person', bold: true }])
    renameTagsInDoc(doc, [{ from: 'person', to: 'people' }])
    expect(text.toDelta()).toEqual([
      { insert: 'see ' },
      { insert: '#people', attributes: { bold: true } }
    ])
  })
})
