import { describe, it, expect, vi, beforeEach } from 'vitest'

const getDoc = vi.fn()
const markdownToBlocks = vi.fn()
const blocksToYFragment = vi.fn()

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc }),
  ORIGIN_LOCAL: 'local'
}))
vi.mock('../sync/blocknote-converter', () => ({
  markdownToBlocks: (...a: unknown[]) => markdownToBlocks(...a),
  blocksToYFragment: (...a: unknown[]) => blocksToYFragment(...a)
}))

import { replaceNoteBodyInCrdt, replaceNoteTagsInCrdt } from './crdt-feed'

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
  markdownToBlocks.mockReset()
  blocksToYFragment.mockReset()
})

describe('replaceNoteBodyInCrdt', () => {
  it('returns false when no doc is open', async () => {
    getDoc.mockReturnValue(null)
    expect(await replaceNoteBodyInCrdt('n1', '# hi')).toBe(false)
    expect(markdownToBlocks).not.toHaveBeenCalled()
  })

  it('returns false when markdown does not parse', async () => {
    getDoc.mockReturnValue(makeDoc())
    markdownToBlocks.mockResolvedValue(null)
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
    expect(markdownToBlocks).not.toHaveBeenCalled()
    expect(doc.transact).not.toHaveBeenCalled()
  })

  it('clears the fragment then rebuilds it once when a doc is open', async () => {
    const doc = makeDoc()
    getDoc.mockReturnValue(doc)
    markdownToBlocks.mockResolvedValue([{ type: 'paragraph' }])
    const ok = await replaceNoteBodyInCrdt('n1', '# hi')
    expect(ok).toBe(true)
    expect(doc._fragment.delete).toHaveBeenCalledWith(0, 3)
    expect(blocksToYFragment).toHaveBeenCalledTimes(1)
    expect(doc.transact).toHaveBeenCalledTimes(1)
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
