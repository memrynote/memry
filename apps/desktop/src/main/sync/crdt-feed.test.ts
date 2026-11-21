import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

const getDoc = vi.fn()
const prepareFragmentSeed = vi.fn()
const applyFragmentSideChannels = vi.fn()
const recordMarkdownSourceInYDoc = vi.fn()

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc }),
  ORIGIN_LOCAL: 'local'
}))
vi.mock('../sync/blocknote-converter', () => ({
  setVaultEmbedResolver: () => {},
  prepareFragmentSeed: (...a: unknown[]) => prepareFragmentSeed(...a),
  applyFragmentSideChannels: (...a: unknown[]) => applyFragmentSideChannels(...a),
  blocksToYFragment: (blocks: Array<{ text: string }>, fragment: Y.XmlFragment) => {
    fragment.insert(0, [blockGroup(blocks.map((b) => b.text))])
    return true
  },
  recordMarkdownSourceInYDoc: (...a: unknown[]) => recordMarkdownSourceInYDoc(...a)
}))

import { replaceNoteBodyInCrdt, replaceNoteTagsInCrdt } from './crdt-feed'

/** A BlockNote-shaped block group: one blockContainer per paragraph text. */
function blockGroup(texts: string[]): Y.XmlElement {
  const group = new Y.XmlElement('blockGroup')
  group.insert(
    0,
    texts.map((text) => {
      const container = new Y.XmlElement('blockContainer')
      container.insert(0, [new Y.XmlText(text)])
      return container
    })
  )
  return group
}

function makeDoc() {
  const fragment = { delete: vi.fn(), length: 3 }
  return {
    getXmlFragment: vi.fn(() => fragment),
    transact: vi.fn((fn: () => void) => fn()),
    _fragment: fragment
  }
}

function makeTagDoc(initialTags: string[] = ['work', 'daily']) {
  const tagArray = {
    delete: vi.fn(),
    push: vi.fn(),
    length: initialTags.length
  }
  return {
    getArray: vi.fn(() => tagArray),
    transact: vi.fn((fn: () => void) => fn()),
    _tagArray: tagArray
  }
}

beforeEach(() => {
  getDoc.mockReset()
  prepareFragmentSeed.mockReset()
  applyFragmentSideChannels.mockReset()
  recordMarkdownSourceInYDoc.mockReset()
})

describe('replaceNoteBodyInCrdt', () => {
  it('returns false when no doc is open', async () => {
    getDoc.mockReturnValue(null)
    expect(await replaceNoteBodyInCrdt('n1', '# hi')).toBe(false)
    expect(prepareFragmentSeed).not.toHaveBeenCalled()
  })

  it('returns false when markdown does not parse', async () => {
    getDoc.mockReturnValue(makeDoc())
    prepareFragmentSeed.mockResolvedValue(null)
    expect(await replaceNoteBodyInCrdt('n1', '')).toBe(false)
  })

  it('refuses markdown over the note-class bounds', async () => {
    // #given the body a receiver writes back after an oversized note arrives
    // over sync: one blank-line-free block far over NOTE_MAX_BLOCK_BYTES. The
    // watcher feeds the file it just wrote straight back in here, so without
    // this guard the receiver pays the very parse the write-back avoided.
    const doc = makeDoc()
    getDoc.mockReturnValue(doc)
    const dump = Array.from({ length: 8_000 }, (_, i) => `2026-08-15 worker payload ${i}`).join(
      '\n'
    )

    // #then no parse, no transaction, and the live doc is left alone
    expect(await replaceNoteBodyInCrdt('n1', dump)).toBe(false)
    expect(prepareFragmentSeed).not.toHaveBeenCalled()
    expect(doc.transact).not.toHaveBeenCalled()
  })

  it('replaces the body in one transaction and keeps the unchanged blocks', async () => {
    // #given an open doc holding A, B, C
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('prosemirror')
    fragment.insert(0, [blockGroup(['A', 'B', 'C'])])
    const group = fragment.get(0) as Y.XmlElement
    const [keptStart, , keptEnd] = group.toArray()
    getDoc.mockReturnValue(doc)
    const prepared = {
      blocks: [{ text: 'A' }, { text: 'X' }, { text: 'C' }],
      plainText: 'A\n\nX\n\nC'
    }
    prepareFragmentSeed.mockResolvedValue(prepared)
    const transactions = vi.fn()
    doc.on('afterTransaction', transactions)

    // #when the file's body changes only the middle block
    const ok = await replaceNoteBodyInCrdt('n1', 'A\n\nX\n\nC')

    // #then the doc holds the new body, and A and C keep their Yjs items, so a
    // peer edit inside them still lands (#5319)
    expect(ok).toBe(true)
    expect(fragment.toString()).toBe(
      '<blockgroup><blockcontainer>A</blockcontainer><blockcontainer>X</blockcontainer><blockcontainer>C</blockcontainer></blockgroup>'
    )
    expect(group.get(0)).toBe(keptStart)
    expect(group.get(2)).toBe(keptEnd)
    expect(transactions).toHaveBeenCalledTimes(1)
    expect(applyFragmentSideChannels).toHaveBeenCalledWith(prepared, fragment)
    // The file's new bytes become the source the write-back preserves (#1915).
    expect(recordMarkdownSourceInYDoc).toHaveBeenCalledWith(doc, 'A\n\nX\n\nC', 'prosemirror')
  })
})

describe('replaceNoteTagsInCrdt', () => {
  it('returns false when no doc is open', () => {
    getDoc.mockReturnValue(null)
    expect(replaceNoteTagsInCrdt('n1', ['work'])).toBe(false)
  })

  it('clears the tag array then pushes the new tags once when a doc is open', () => {
    const doc = makeTagDoc()
    getDoc.mockReturnValue(doc)
    const ok = replaceNoteTagsInCrdt('n1', ['work', 'daily', 'meeting'])
    expect(ok).toBe(true)
    expect(doc._tagArray.delete).toHaveBeenCalledWith(0, 2)
    expect(doc._tagArray.push).toHaveBeenCalledTimes(1)
    expect(doc._tagArray.push).toHaveBeenCalledWith(['work', 'daily', 'meeting'])
    expect(doc.transact).toHaveBeenCalledTimes(1)
  })

  it('clears the tag array and does not push when new tags is empty', () => {
    const doc = makeTagDoc()
    getDoc.mockReturnValue(doc)
    const ok = replaceNoteTagsInCrdt('n1', [])
    expect(ok).toBe(true)
    expect(doc._tagArray.delete).toHaveBeenCalledWith(0, 2)
    expect(doc._tagArray.push).not.toHaveBeenCalled()
  })
})
