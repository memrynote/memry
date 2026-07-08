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

import { replaceNoteBodyInCrdt } from './crdt-feed'

function makeDoc() {
  const fragment = { delete: vi.fn(), length: 3 }
  return {
    getXmlFragment: vi.fn(() => fragment),
    transact: vi.fn((fn: () => void) => fn()),
    _fragment: fragment
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
