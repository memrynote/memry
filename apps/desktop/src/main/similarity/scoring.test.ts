import { describe, expect, it } from 'vitest'
import {
  clusterBySimilarity,
  cosineSimilarity,
  scoreNeighbourTags,
  suggestGroupName
} from './scoring'

const v = (...values: number[]): Float32Array => Float32Array.from(values)

describe('cosineSimilarity', () => {
  it('is 1 for parallel vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity(v(1, 2), v(2, 4))).toBeCloseTo(1)
    expect(cosineSimilarity(v(1, 0), v(0, 1))).toBeCloseTo(0)
  })

  it('is 0 when a vector has no length', () => {
    expect(cosineSimilarity(v(0, 0), v(1, 1))).toBe(0)
  })
})

describe('scoreNeighbourTags', () => {
  it('prefers a tag several neighbours agree on over one close fluke', () => {
    const scored = scoreNeighbourTags(
      [
        // A lone hit keeps 70% of its similarity (0.63); three agreeing
        // neighbours keep 90% (0.675), so the pattern outranks the fluke.
        { similarity: 0.9, tags: ['fluke'] },
        { similarity: 0.75, tags: ['sleep'] },
        { similarity: 0.75, tags: ['sleep'] },
        { similarity: 0.75, tags: ['sleep'] }
      ],
      { minSupport: 1 }
    )
    expect(scored.map((tag) => tag.tag)).toEqual(['sleep', 'fluke'])
    expect(scored[0].support).toBe(3)
  })

  it('drops tags the note already has, case-insensitively', () => {
    const scored = scoreNeighbourTags(
      [
        { similarity: 0.7, tags: ['Health', 'sleep'] },
        { similarity: 0.7, tags: ['health', 'sleep'] }
      ],
      { exclude: ['HEALTH'] }
    )
    expect(scored.map((tag) => tag.tag)).toEqual(['sleep'])
  })

  it('applies similarity, support and confidence floors', () => {
    const neighbours = [
      { similarity: 0.2, tags: ['far'] },
      { similarity: 0.2, tags: ['far'] },
      { similarity: 0.8, tags: ['alone'] },
      { similarity: 0.5, tags: ['pair'] },
      { similarity: 0.5, tags: ['pair'] }
    ]
    expect(
      scoreNeighbourTags(neighbours, { minSimilarity: 0.3, minSupport: 2 }).map((t) => t.tag)
    ).toEqual(['pair'])
    expect(scoreNeighbourTags(neighbours, { minSimilarity: 0.3, minConfidence: 0.9 })).toEqual([])
  })

  it('shows the casing most neighbours use', () => {
    const scored = scoreNeighbourTags([
      { similarity: 0.6, tags: ['Sleep'] },
      { similarity: 0.6, tags: ['sleep'] },
      { similarity: 0.6, tags: ['sleep'] }
    ])
    expect(scored[0].tag).toBe('sleep')
  })

  it('respects the limit', () => {
    const scored = scoreNeighbourTags(
      [
        { similarity: 0.6, tags: ['a', 'b', 'c'] },
        { similarity: 0.6, tags: ['a', 'b', 'c'] }
      ],
      { limit: 2 }
    )
    expect(scored).toHaveLength(2)
  })
})

describe('clusterBySimilarity', () => {
  it('groups items by topic and leaves outliers ungrouped', () => {
    const result = clusterBySimilarity(
      [
        { id: 'sleep-1', vector: v(1, 0.1, 0) },
        { id: 'code-1', vector: v(0, 1, 0.1) },
        { id: 'sleep-2', vector: v(0.9, 0.2, 0) },
        { id: 'code-2', vector: v(0.1, 1, 0) },
        { id: 'code-3', vector: v(0, 0.9, 0.2) },
        { id: 'outlier', vector: v(0, 0, 1) }
      ],
      { threshold: 0.8 }
    )
    expect(result.groups).toEqual([
      ['code-1', 'code-2', 'code-3'],
      ['sleep-1', 'sleep-2']
    ])
    expect(result.ungrouped).toEqual(['outlier'])
  })

  it('does not chain two topics through one bridging item', () => {
    // `bridge` is close to both ends, but the ends are unrelated: average
    // linkage must not pull all three into one group.
    const result = clusterBySimilarity(
      [
        { id: 'a', vector: v(1, 0) },
        { id: 'bridge', vector: v(1, 1) },
        { id: 'b', vector: v(0, 1) }
      ],
      { threshold: 0.6 }
    )
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toHaveLength(2)
    expect(result.ungrouped).toHaveLength(1)
  })

  it('handles empty and single inputs', () => {
    expect(clusterBySimilarity([], { threshold: 0.5 })).toEqual({ groups: [], ungrouped: [] })
    expect(clusterBySimilarity([{ id: 'x', vector: v(1) }], { threshold: 0.5 })).toEqual({
      groups: [],
      ungrouped: ['x']
    })
  })
})

describe('suggestGroupName', () => {
  it('uses a tag most members share', () => {
    expect(
      suggestGroupName([
        { tags: ['health/sleep'], folder: 'a' },
        { tags: ['Health/Sleep', 'x'], folder: 'b' },
        { tags: [], folder: 'c' }
      ])
    ).toBe('health/sleep')
  })

  it('falls back to the last segment of a shared folder', () => {
    expect(
      suggestGroupName([
        { tags: [], folder: 'areas/health' },
        { tags: ['a'], folder: 'areas/health' }
      ])
    ).toBe('health')
  })

  it('is null when nothing is shared by half the group', () => {
    expect(
      suggestGroupName([
        { tags: ['a'], folder: 'x' },
        { tags: ['b'], folder: 'y' },
        { tags: ['c'], folder: 'z' }
      ])
    ).toBeNull()
  })
})
