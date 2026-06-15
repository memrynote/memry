import { describe, it, expect } from 'vitest'
import { exceedsMaxSize, MAX_ASSET_BYTES } from './asset-filter.ts'

describe('exceedsMaxSize', () => {
  it('returns false for an asset smaller than the limit', () => {
    expect(exceedsMaxSize(1024)).toBe(false)
  })

  it('returns false for an asset exactly at the limit', () => {
    expect(exceedsMaxSize(MAX_ASSET_BYTES)).toBe(false)
  })

  it('returns true for an asset one byte over the limit', () => {
    expect(exceedsMaxSize(MAX_ASSET_BYTES + 1)).toBe(true)
  })

  it('accepts a custom maxBytes override', () => {
    expect(exceedsMaxSize(100, 99)).toBe(true)
    expect(exceedsMaxSize(99, 99)).toBe(false)
  })

  it('MAX_ASSET_BYTES is 10 MiB', () => {
    expect(MAX_ASSET_BYTES).toBe(10 * 1024 * 1024)
  })
})
