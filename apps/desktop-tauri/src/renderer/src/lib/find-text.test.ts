import { describe, expect, it } from 'vitest'
import { findOffsets } from './find-text'

describe('findOffsets', () => {
  it('finds every occurrence regardless of case', () => {
    expect(findOffsets('Kedi, kedi ve KEDI', 'kedi')).toEqual([0, 6, 14])
  })

  it('counts overlapping occurrences', () => {
    expect(findOffsets('aaa', 'aa')).toEqual([0, 1])
  })

  it('finds nothing for an empty query', () => {
    expect(findOffsets('kedi', '')).toEqual([])
  })
})
