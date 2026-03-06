import { describe, expect, it } from 'vitest'
import { utcNow } from './utc'

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('utcNow', () => {
  it('returns ISO 8601 format with Z suffix', () => {
    expect(utcNow()).toMatch(ISO_8601_REGEX)
  })

  it('round-trips through Date constructor', () => {
    const ts = utcNow()
    const parsed = new Date(ts)
    expect(parsed.toISOString()).toBe(ts)
  })

  it('is monotonically non-decreasing across calls', () => {
    const a = utcNow()
    const b = utcNow()
    expect(b >= a).toBe(true)
  })
})
