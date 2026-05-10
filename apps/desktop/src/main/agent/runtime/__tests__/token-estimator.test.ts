import { describe, expect, it } from 'vitest'

import { COMPACTION_THRESHOLD, estimateTokens } from '../token-estimator'

describe('Token estimator', () => {
  it('roughly approximates 4 chars per token', () => {
    expect(estimateTokens('a'.repeat(4))).toBe(1)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('rounds up partial tokens', () => {
    expect(estimateTokens('a'.repeat(5))).toBe(2)
  })

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('exposes a 100k token compaction threshold', () => {
    expect(COMPACTION_THRESHOLD).toBe(100_000)
  })
})
