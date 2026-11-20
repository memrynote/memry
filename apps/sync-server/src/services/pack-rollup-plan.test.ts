import { describe, expect, it } from 'vitest'

import { planRollup, type ListedPack } from './pack-rollup'

const pack = (id: string, minCursor: number): ListedPack => ({
  id,
  pack_key: `u/vaults/v/packs/crdt_update/${minCursor}_${minCursor + 5}_${id}.pack`,
  min_cursor: minCursor,
  max_cursor: minCursor + 5,
  item_count: 1,
  byte_size: 10,
  cover_from: null,
  cover_through: null
})

describe('planRollup', () => {
  // REVIEW-5283: the purge's rewrite lists its pack back at the range it held,
  // so a run merged across that range would overlap it.
  it('never merges across the range of a pack waiting for its purge rewrite', () => {
    const packs = [pack('a', 10), pack('b', 30), pack('c', 40)]

    expect(planRollup(packs, new Set(), [20]).map((p) => p.id)).toEqual(['b', 'c'])
    expect(planRollup(packs, new Set(), []).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })
})
