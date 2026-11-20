import { describe, expect, it } from 'vitest'

import { PACK_MAX_ENTRIES } from '@memry/contracts/pack-format'

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

  // #5310: a snapshot pack listed below a taken second starts inside another
  // pack's range. A run that ends before it would be refused by the swap guard
  // every message, so the planner never picks one.
  it('never ends a run at a pack that a later pack starts inside', () => {
    const at = (id: string, min: number, max: number, items: number): ListedPack => ({
      ...pack(id, min),
      max_cursor: max,
      item_count: items
    })
    const before = at('before', 1, 5, 1)
    const full = at('full', 10, 20, PACK_MAX_ENTRIES - 1)
    const inside = at('inside', 15, 15, 2)

    expect(planRollup([before, full, inside])).toEqual([])
    expect(planRollup([before, full, at('inside', 15, 15, 1)]).map((p) => p.id)).toEqual([
      'full',
      'inside'
    ])
  })
})
