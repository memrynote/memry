import { describe, expect, it } from 'vitest'
import { localInputToIso } from './date-utils'

describe('localInputToIso', () => {
  it('converts a timed local input into an ISO 8601 UTC string ending in Z', () => {
    const result = localInputToIso('2026-04-17T09:30', false)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('prepends midnight for all-day inputs and returns a valid ISO string', () => {
    const result = localInputToIso('2026-04-17', true)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('throws when the input cannot be parsed as a date', () => {
    expect(() => localInputToIso('not-a-date', false)).toThrow(/invalid/i)
  })
})
